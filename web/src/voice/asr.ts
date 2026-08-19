// ---------------------------------------------------------------------------
// Prompt 15 — the ASR tier behind a swappable provider interface.
//
//   DeepgramProvider  — primary when DEEPGRAM_API_KEY exists and we're online:
//                       streaming websocket with keyword boosting from the
//                       GENERATED grammar lexicon (buildLexicon), so the ASR
//                       vocabulary and the command grammar never drift apart.
//   WebSpeechProvider — keyless fallback (hard constraint: the platform runs
//                       with zero keys). Browser-native recognition; no
//                       vocabulary boosting, so it is labeled BROWSER ASR and
//                       leans on Tier A's homophone hardening.
//
// True offline ASR (whisper.cpp small, on-device) is the tablet-build path —
// the browser demo has no WASM whisper bundled; when navigator.onLine is
// false the UI shows "OFFLINE VOICE — CORE COMMANDS" and scenario-injected
// transcripts still exercise the full intent pipeline with zero ASR keys.
//
// PTT audio is a SEPARATE stream from the radio-transcription pipeline with
// separate retention rules: nothing here buffers or persists audio — frames
// go straight to the recognizer and are dropped. (A pilot-evaluation
// retention flag would need an explicit on-screen banner; deliberately not
// implemented.)
// ---------------------------------------------------------------------------

import { buildLexicon } from './grammar'

export interface AsrCallbacks {
  onPartial: (text: string) => void
  onFinal: (text: string) => void
  onError: (msg: string) => void
}

export interface AsrProvider {
  readonly name: 'deepgram' | 'webspeech'
  start(cb: AsrCallbacks): Promise<void>
  /** Release of the PTT — end of utterance. Must flush a final transcript. */
  stop(): void
}

const DEEPGRAM_KEY = ((import.meta.env.DEEPGRAM_API_KEY as string | undefined) ?? '').trim()

// ---- Deepgram streaming -----------------------------------------------------

class DeepgramProvider implements AsrProvider {
  readonly name = 'deepgram' as const
  private ws: WebSocket | null = null
  private media: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private finals: string[] = []
  private cb: AsrCallbacks | null = null

  async start(cb: AsrCallbacks): Promise<void> {
    this.cb = cb
    this.finals = []
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const params = new URLSearchParams({
      model: 'nova-2',
      interim_results: 'true',
      punctuate: 'false',
      numerals: 'true',
    })
    // Keyword boosting from the generated lexicon — one param per keyword.
    for (const word of buildLexicon()) params.append('keywords', `${word}:2`)
    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, ['token', DEEPGRAM_KEY])
      this.ws = ws
      ws.onopen = () => {
        const media = new MediaRecorder(this.stream as MediaStream, { mimeType: 'audio/webm;codecs=opus' })
        this.media = media
        media.ondataavailable = (e) => {
          if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) ws.send(e.data)
        }
        media.start(250)
        resolve()
      }
      ws.onerror = () => reject(new Error('deepgram socket failed'))
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string) as {
            is_final?: boolean
            channel?: { alternatives?: { transcript?: string }[] }
          }
          const text = msg.channel?.alternatives?.[0]?.transcript ?? ''
          if (!text) return
          if (msg.is_final) {
            this.finals.push(text)
            this.cb?.onPartial(this.finals.join(' '))
          } else {
            this.cb?.onPartial([...this.finals, text].join(' '))
          }
        } catch {
          /* keep streaming */
        }
      }
    })
  }

  stop(): void {
    this.media?.stop()
    this.stream?.getTracks().forEach((t) => t.stop())
    // Deepgram flushes remaining finals on CloseStream.
    try {
      this.ws?.send(JSON.stringify({ type: 'CloseStream' }))
    } catch {
      /* already closed */
    }
    const finish = () => {
      this.cb?.onFinal(this.finals.join(' ').trim())
      this.ws?.close()
      this.ws = null
      this.media = null
      this.stream = null
    }
    // Give the socket a beat to deliver the trailing final.
    setTimeout(finish, 350)
  }
}

// ---- Web Speech (keyless fallback) -------------------------------------------

interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

class WebSpeechProvider implements AsrProvider {
  readonly name = 'webspeech' as const
  private rec: SpeechRecognitionLike | null = null
  private finals = ''
  private interim = ''
  private cb: AsrCallbacks | null = null
  private stopping = false

  async start(cb: AsrCallbacks): Promise<void> {
    const Ctor = (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike; SpeechRecognition?: new () => SpeechRecognitionLike })
    const Cls = Ctor.SpeechRecognition ?? Ctor.webkitSpeechRecognition
    if (!Cls) throw new Error('speech recognition unavailable in this browser')
    this.cb = cb
    this.finals = ''
    this.interim = ''
    this.stopping = false
    const rec = new Cls()
    this.rec = rec
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-US'
    rec.onresult = (e) => {
      this.interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) this.finals += `${r[0].transcript} `
        else this.interim += r[0].transcript
      }
      this.cb?.onPartial(`${this.finals}${this.interim}`.trim())
    }
    rec.onerror = (e) => {
      if (e.error === 'aborted' || e.error === 'no-speech') return
      // Raw Web Speech codes read as gibberish on the chip — translate the
      // ones an operator can act on.
      const msg =
        e.error === 'not-allowed' || e.error === 'service-not-allowed'
          ? 'microphone blocked — allow mic access in the browser bar'
          : e.error === 'network'
            ? 'speech service unreachable — check the connection'
            : `asr: ${e.error}`
      this.cb?.onError(msg)
    }
    rec.onend = () => {
      if (this.stopping) {
        this.cb?.onFinal(`${this.finals}${this.interim}`.trim())
        return
      }
      // Chrome self-ends continuous recognition after a few quiet seconds —
      // while the PTT is still HELD that must not wedge the chip in
      // LISTENING with the utterance dropped. Restart and keep capturing;
      // accumulated finals survive because they live on `this`, not on rec.
      try {
        rec.start()
      } catch {
        // Restart refused (tab losing focus, service gone) — deliver what
        // we have instead of nothing.
        this.cb?.onFinal(`${this.finals}${this.interim}`.trim())
      }
    }
    rec.start()
  }

  stop(): void {
    this.stopping = true
    this.rec?.stop()
  }
}

/** Provider selection: Deepgram when keyed + online; browser ASR otherwise.
 *  Keyless installs never require a key — hard platform constraint. */
export function pickProvider(): AsrProvider {
  if (DEEPGRAM_KEY && navigator.onLine) return new DeepgramProvider()
  return new WebSpeechProvider()
}

export function asrModeLabel(name: 'deepgram' | 'webspeech'): string {
  if (name === 'deepgram') return 'DEEPGRAM LIVE'
  return navigator.onLine ? 'BROWSER ASR' : 'OFFLINE VOICE — CORE COMMANDS'
}
