import { useEffect, useRef, useState } from 'react'
import { setAppState, useAppSlice } from '../state/store'
import { asrModeLabel, pickProvider, type AsrProvider } from '../voice/asr'
import { handleFinalTranscript, tapCancel, tapConfirm } from '../voice/controller'
import { COMMANDS } from '../voice/grammar'
import './PttButton.css'

// ---------------------------------------------------------------------------
// Prompt 15 — the push-to-talk control. HOLD to talk (pointer or SPACEBAR),
// release = end of utterance. NO WAKE WORD — ever: the fireground is
// saturated with radio traffic using exactly this vocabulary, so hold-to-talk
// is the only activation, with no option to change that.
// ---------------------------------------------------------------------------

export function PttButton() {
  const { listening, partial, asr, echo, confirm, replies, helpOpen, gloveMode } = useAppSlice((s) => ({
    listening: s.voiceListening,
    partial: s.voicePartial,
    asr: s.voiceAsr,
    echo: s.voiceEcho,
    confirm: s.voiceConfirm,
    replies: s.voiceReplies,
    helpOpen: s.voiceHelpOpen,
    gloveMode: s.gloveMode,
  }))
  const providerRef = useRef<AsrProvider | null>(null)
  const [asrErr, setAsrErr] = useState<string | null>(null)

  const press = () => {
    if (providerRef.current) return // already held
    setAsrErr(null)
    const provider = pickProvider()
    providerRef.current = provider
    setAppState({ voiceListening: true, voiceAsr: provider.name, voicePartial: '' })
    if (navigator.vibrate) navigator.vibrate(20)
    provider
      .start({
        onPartial: (text) => setAppState({ voicePartial: text }),
        onFinal: (text) => {
          setAppState({ voiceListening: false, voiceAsr: null })
          void handleFinalTranscript(text, 'ptt')
        },
        onError: (msg) => {
          providerRef.current = null
          setAppState({ voiceListening: false, voiceAsr: null, voicePartial: '' })
          setAsrErr(msg)
        },
      })
      .catch((err: Error) => {
        providerRef.current = null
        setAppState({ voiceListening: false, voiceAsr: null })
        setAsrErr(err.message)
      })
  }

  const release = () => {
    const provider = providerRef.current
    providerRef.current = null
    if (!provider) return
    if (navigator.vibrate) navigator.vibrate(10)
    provider.stop()
  }

  // Hardware key binding: hold SPACE for eyes-free use (desktop). Ignored
  // while typing in an input/textarea/select/contenteditable.
  useEffect(() => {
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null
      return !!el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable)
    }
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      e.preventDefault()
      press()
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || typing(e.target)) return
      e.preventDefault()
      release()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
    // press/release close over refs + store only — stable for the app's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const groups = new Map<string, string[]>()
  for (const c of COMMANDS) {
    if (!groups.has(c.group)) groups.set(c.group, [])
    groups.get(c.group)!.push(...c.examples)
  }

  return (
    <div className={`ptt-root${gloveMode ? ' glove' : ''}`}>
      {helpOpen && (
        <div className="ptt-help glass">
          <div className="ptt-help-head">
            <b>VOICE COMMANDS — HOLD PTT (OR SPACE) AND SPEAK</b>
            <button onClick={() => setAppState({ voiceHelpOpen: false })}>✕</button>
          </div>
          <div className="ptt-help-body">
            {[...groups.entries()].map(([group, examples]) => (
              <section key={group}>
                <h4>{group}</h4>
                <ul>
                  {examples.map((ex) => (
                    <li key={ex}>“{ex}”</li>
                  ))}
                </ul>
              </section>
            ))}
            <p className="ptt-help-note">
              Anything state-changing is drafted first and needs CONFIRM. PAR confirmation, mayday
              acknowledgement, and riding-list edits are tap-only — voice always refuses them.
            </p>
          </div>
        </div>
      )}

      {confirm && (
        <div className="ptt-confirm glass" role="alertdialog">
          <div className="ptt-confirm-draft">{confirm.draft}</div>
          <div className="ptt-confirm-row">
            <button className="ptt-confirm-go" onClick={() => void tapConfirm()}>
              ✓ CONFIRM
            </button>
            <button className="ptt-confirm-no" onClick={tapCancel}>
              ✕ CANCEL
            </button>
          </div>
          <div className="ptt-confirm-hint">or hold PTT and say “confirm” / “cancel”</div>
        </div>
      )}

      {(listening || partial) && (
        <div className="ptt-strip glass">
          {asr && <span className="ptt-mode">{asrModeLabel(asr)}</span>}
          <span className={`ptt-partial${partial ? '' : ' idle'}`}>{partial || 'LISTENING…'}</span>
        </div>
      )}

      {echo && !listening && (
        <div className={`ptt-echo glass ${echo.tone}`}>
          {echo.text.split('\n').map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
      {asrErr && !listening && !echo && <div className="ptt-echo glass warn">MIC UNAVAILABLE — {asrErr.toUpperCase()}</div>}

      <div className="ptt-side">
        <button
          className={`ptt-mini${replies ? ' on' : ''}`}
          title="Voice replies (spoken answers to queries) — default OFF: a tablet talking over radio traffic is a liability"
          onClick={() => {
            const on = !replies
            setAppState({ voiceReplies: on })
            localStorage.setItem('ks-voice-replies', on ? '1' : '0')
          }}
        >
          {replies ? '🔊' : '🔇'}
        </button>
        <button className="ptt-mini" title="Voice commands reference" onClick={() => setAppState({ voiceHelpOpen: true })}>
          ?
        </button>
      </div>

      <button
        className={`ptt-btn${listening ? ' live' : ''}`}
        onPointerDown={press}
        onPointerUp={release}
        onPointerLeave={release}
        onContextMenu={(e) => e.preventDefault()}
        title="HOLD to talk (or hold SPACE) — release to execute. No wake word."
      >
        {listening ? (
          <span className="ptt-wave" aria-hidden>
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
        ) : (
          <span className="ptt-mic" aria-hidden>
            🎙
          </span>
        )}
        <span className="ptt-label">{listening ? 'RELEASE TO SEND' : 'HOLD · PTT'}</span>
      </button>
    </div>
  )
}
