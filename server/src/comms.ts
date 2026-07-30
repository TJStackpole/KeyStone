import { EventEmitter } from 'node:events'
import WebSocket from 'ws'

// ---------------------------------------------------------------------------
// Comms fusion (Phase 7).
//
// FDNY channel: real Whisper transcription lines from the sidecar (which is
// transcribing either the bundled FDNY-style recording streamed as-if-live, or
// an authenticated Broadcastify stream when BROADCASTIFY_URL is set).
//
// NYPD / EMS / OEM channels: SCRIPTED SIMULATION, clearly watermarked in the
// UI. NYPD's radio system has been encrypted since its 2023+ migration — real
// interception is neither possible nor legal, hence simulation. Similarly,
// Broadcastify's terms restrict rebroadcast/embedding; the private demo uses
// the operator's own authenticated premium stream URL from .env, and a
// production deployment would ingest the department's own authorized
// radio-over-IP feed instead. (See README "Comms & legal posture".)
// ---------------------------------------------------------------------------

/** Live-mode channels (Phase 7). */
export type LiveChannel = 'fdny' | 'nypd' | 'ems' | 'oem'
/** Scenario multi-channel radio (Prompt 8A). */
export type ScenarioChannel = 'fdny-tac' | 'fdny-cmd' | 'ems-cw' | 'nypd-sod' | 'papd' | 'interagency'
export type CommsChannel = LiveChannel | ScenarioChannel

export interface TranscriptKeyword {
  kind: 'unit' | 'code' | 'urgent' | 'address'
  text: string
  /** Normalized roster callsign for unit keywords, e.g. "E-6". */
  callsign?: string
}

export interface TranscriptLine {
  ts: string
  text: string
  keywords: TranscriptKeyword[]
  live: boolean
}

const UNIT_PREFIX: Record<string, string> = {
  engine: 'E',
  ladder: 'L',
  battalion: 'BC',
  rescue: 'R',
  squad: 'SQ',
  e: 'E',
  l: 'L',
  bc: 'BC',
  r: 'R',
  sq: 'SQ',
  ems: 'EMS',
  pd: 'PD',
}

const UNIT_RE = /\b(engine|ladder|battalion|rescue|squad|ems|pd|e|l|bc|sq|r)[- ]?(\d+)\b/gi
const CODE_RE =
  /\b(10[- ]?75|10[- ]?60|10[- ]?45|all hands|second alarm|2nd alarm|third alarm|3rd alarm|mayday|MCI|PAR|exposure [1-4])\b/gi
const URGENT_RE = /\b(urgent|mayday|evacuate|collapse|CNG)\b/gi
const ADDRESS_RE = /\b\d{1,4} [A-Z][a-zA-Z]+ (Street|Avenue|Place|Road|Boulevard|Broadway|Plaza|Lane)\b/g

export function extractKeywords(text: string): TranscriptKeyword[] {
  const out: TranscriptKeyword[] = []
  for (const m of text.matchAll(UNIT_RE)) {
    const prefix = UNIT_PREFIX[m[1].toLowerCase()]
    if (prefix) out.push({ kind: 'unit', text: m[0], callsign: `${prefix}-${Number(m[2])}` })
  }
  for (const m of text.matchAll(CODE_RE)) out.push({ kind: 'code', text: m[0] })
  for (const m of text.matchAll(URGENT_RE)) out.push({ kind: 'urgent', text: m[0] })
  for (const m of text.matchAll(ADDRESS_RE)) out.push({ kind: 'address', text: m[0] })
  return out
}

/** WS client to the whisper sidecar; reconnects forever. Emits 'line'. */
export class WhisperLink extends EventEmitter {
  private backoff = 2000

  constructor(private readonly url: string) {
    super()
  }

  start(): void {
    this.connect()
  }

  private connect(): void {
    const ws = new WebSocket(this.url)
    ws.on('open', () => {
      this.backoff = 2000
      console.log(`[comms] whisper sidecar linked at ${this.url}`)
    })
    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(String(raw)) as { text?: string; live?: boolean }
        if (!msg.text) return
        const line: TranscriptLine = {
          ts: new Date().toISOString(),
          text: msg.text,
          keywords: extractKeywords(msg.text),
          live: !!msg.live,
        }
        this.emit('line', line)
      } catch {
        // ignore malformed sidecar output
      }
    })
    const retry = () => {
      setTimeout(() => this.connect(), this.backoff)
      this.backoff = Math.min(this.backoff * 1.6, 20_000)
    }
    ws.on('close', retry)
    ws.on('error', () => ws.close())
  }
}

// ------------------------------ SIM channels --------------------------------

interface SimScriptLine {
  offset: number
  text: string
}

/** Scenario-consistent scripted traffic. SIMULATED — watermarked in the UI. */
const SIM_SCRIPTS: Record<Exclude<LiveChannel, 'fdny'>, SimScriptLine[]> = {
  nypd: [
    { offset: 4, text: 'Central to units on the Gold Street detail, fire department operating, hold traffic at Fulton and Gold.' },
    { offset: 18, text: 'PD-1 on scene, establishing the frozen zone at Frankfort and Gold.' },
    { offset: 34, text: 'PD-2 to Central, Spruce Street is shut down at Park Row, buses being rerouted.' },
    { offset: 52, text: 'Central to PD-3, respond to the staging area for crowd control at the pedestrian plaza.' },
    { offset: 70, text: 'PD-4 to Central, we have the intersection at Beekman, apparatus has clear access.' },
    { offset: 92, text: 'Central to all Gold Street units, ESU notified for standby, no entry into the hot zone without FD escort.' },
    { offset: 110, text: 'PD-1 to Central, perimeter is holding, media staging on the Fulton side.' },
  ],
  ems: [
    { offset: 10, text: 'EMS-01 to Citywide, on scene at the Gold Street box, setting up triage on the cold side.' },
    { offset: 30, text: 'Citywide to EMS-02, stage on Beekman until FD clears the collapse zone.' },
    { offset: 48, text: 'EMS-01, we have one civilian, smoke inhalation, green tag, evaluating at triage.' },
    { offset: 68, text: 'EMS-02 transporting one, adult male, respiratory distress, notification to NewYork-Presbyterian Lower Manhattan.' },
    { offset: 90, text: 'Citywide to EMS units, one additional BLS unit assigned to the box, staging at South Street.' },
    { offset: 108, text: 'EMS-01 to Citywide, triage count update: one red transported, one green released on scene.' },
  ],
  oem: [
    { offset: 14, text: 'Watch Command to OEM-1, interagency notification complete: DOB, Con Edison, and DEP are enroute.' },
    { offset: 36, text: 'OEM-1 to Watch Command, on scene, establishing the interagency staging point east of the ICP.' },
    { offset: 58, text: 'Watch Command: Con Edison reports gas service isolated to 100 Gold Street as of this time.' },
    { offset: 80, text: 'OEM-1, DOB structural engineer is 10 minutes out, will report to the ICP.' },
    { offset: 100, text: 'Watch Command to OEM-1, downtown BID notified, building management on the phone with floor wardens.' },
    { offset: 118, text: 'OEM-1 to Watch Command, situation report sent to City Hall, next update in 30 minutes.' },
  ],
}

/** Loops the scripted channels on their own clocks. Emits ('line', channel, line). */
export class SimComms extends EventEmitter {
  start(): void {
    for (const [channel, script] of Object.entries(SIM_SCRIPTS)) {
      const total = script[script.length - 1].offset + 20
      const run = () => {
        for (const item of script) {
          setTimeout(() => {
            const line: TranscriptLine = {
              ts: new Date().toISOString(),
              text: item.text,
              keywords: extractKeywords(item.text),
              live: false,
            }
            this.emit('line', channel as CommsChannel, line)
          }, item.offset * 1000).unref?.()
        }
        setTimeout(run, total * 1000).unref?.()
      }
      run()
    }
  }
}
