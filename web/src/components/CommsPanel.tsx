import { useEffect, useRef } from 'react'
import { setAppState, useAppState } from '../state/store'
import type { CommsChannel, TranscriptLine } from '../types'

const CHANNELS: { id: CommsChannel; label: string }[] = [
  { id: 'fdny', label: 'FDNY' },
  { id: 'nypd', label: 'NYPD' },
  { id: 'ems', label: 'EMS' },
  { id: 'oem', label: 'OEM' },
]

function hhmmss(iso: string): string {
  return new Date(iso).toTimeString().slice(0, 8)
}

/** Render a line with keyword highlighting (unit designators, codes, urgents, addresses). */
function HighlightedText({ line }: { line: TranscriptLine }) {
  if (!line.keywords.length) return <>{line.text}</>
  // Build a regex of all keyword literals, longest first to avoid partial overlap.
  const parts = [...new Set(line.keywords.map((k) => k.text))].sort((a, b) => b.length - a.length)
  const re = new RegExp(`(${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  const kindOf = (text: string) =>
    line.keywords.find((k) => k.text.toLowerCase() === text.toLowerCase())?.kind ?? 'code'
  const segments = line.text.split(re)
  // (Matched segments equal one of the keyword literals — never re.test() a
  // /g regex per segment; its stateful lastIndex skips alternating matches.)
  return (
    <>
      {segments.map((seg, i) =>
        parts.some((p) => p.toLowerCase() === seg.toLowerCase()) ? (
          <mark key={i} className={`kw-${kindOf(seg)}`}>
            {seg}
          </mark>
        ) : (
          <span key={i}>{seg}</span>
        ),
      )}
    </>
  )
}

export function CommsPanel() {
  const { commsOpen, commsChannel, transcripts, commsConfig, incident } = useAppState()
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // fetch channel config once
    if (!commsConfig) {
      fetch('/api/comms/config')
        .then((r) => r.json())
        .then((cfg) => setAppState({ commsConfig: cfg }))
        .catch(() => undefined)
    }
  }, [commsConfig])

  const lines = transcripts[commsChannel]
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length, commsChannel, commsOpen])

  if (!incident) return null
  if (!commsOpen) {
    return (
      <button className="comms-collapsed glass" onClick={() => setAppState({ commsOpen: true })}>
        COMMS ▴
      </button>
    )
  }

  const isSim = commsChannel !== 'fdny'
  // Honest badge: trust what the transcription pipeline actually delivers
  // (the sidecar falls back to the bundled recording if the live URL fails).
  const fdnyLines = transcripts.fdny
  const fdnyActuallyLive = fdnyLines.length
    ? fdnyLines[fdnyLines.length - 1].live
    : (commsConfig?.live ?? false)

  return (
    <section className="comms-panel glass">
      <div className="comms-tabs">
        {CHANNELS.map((c) => (
          <button
            key={c.id}
            className={`comms-tab${commsChannel === c.id ? ' on' : ''}`}
            onClick={() => setAppState({ commsChannel: c.id })}
          >
            {c.label}
            {c.id === 'fdny' ? (
              <i className={`tab-badge${fdnyActuallyLive ? ' live' : ''}`}>
                {fdnyActuallyLive ? 'LIVE' : 'AS-LIVE'}
              </i>
            ) : (
              <i className="tab-badge sim">SIM</i>
            )}
          </button>
        ))}
        {commsChannel === 'fdny' && commsConfig && (
          <audio
            className="comms-audio"
            controls
            loop={!fdnyActuallyLive}
            src={fdnyActuallyLive ? commsConfig.audioUrl : '/api/audio/fdny-dispatch-demo.mp3'}
            onError={() =>
              setAppState((s) => ({
                commsConfig: s.commsConfig
                  ? { ...s.commsConfig, live: false, audioUrl: '/api/audio/fdny-dispatch-demo.mp3' }
                  : s.commsConfig,
              }))
            }
          />
        )}
        <button className="panel-close" onClick={() => setAppState({ commsOpen: false })}>
          ▾
        </button>
      </div>
      <div className={`comms-scroll${isSim ? ' sim' : ''}`} ref={scrollRef}>
        {isSim && <span className="comms-watermark">SIMULATED</span>}
        {lines.length === 0 && <div className="roster-empty">AWAITING TRAFFIC…</div>}
        {lines.map((l, i) => (
          <div key={`${l.ts}-${i}`} className="comms-line">
            <span className="line-ts">{hhmmss(l.ts)}</span>
            <span className="line-text">
              <HighlightedText line={l} />
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
