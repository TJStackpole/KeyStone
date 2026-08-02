import { memo, useEffect, useMemo, useRef } from 'react'
import { useMovable } from '../lib/movable'
import { useProfile } from '../profiles/manifest'
import { radioChannelsAllowed, usePolicy } from '../profiles/policy'
import { setAppState, useAppSlice } from '../state/store'
import type { CommsChannel, TranscriptLine } from '../types'

const CHANNELS: { id: CommsChannel; label: string }[] = [
  { id: 'fdny', label: 'FDNY' },
  { id: 'nypd', label: 'NYPD' },
  { id: 'ems', label: 'EMS' },
  { id: 'oem', label: 'OEM' },
]

/** Multi-channel radio while a scenario is loaded (Prompt 8A §3). */
const SCENARIO_CHANNELS: { id: CommsChannel; label: string }[] = [
  { id: 'fdny-tac', label: 'FD TAC' },
  { id: 'fdny-cmd', label: 'FD CMD' },
  { id: 'ems-cw', label: 'EMS CW' },
  { id: 'nypd-sod', label: 'NYPD SOD' },
  { id: 'papd', label: 'PAPD' },
  { id: 'interagency', label: 'IA' },
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

/**
 * One transcript row, memoized: line objects are referentially stable across
 * store writes (ws.ts appends, never mutates), so the 200-row scroll skips
 * re-rendering — and re-compiling each row's highlight regex — on every
 * units.batch (~1-2 s all incident long).
 */
const CommsLine = memo(function CommsLine({ line }: { line: TranscriptLine }) {
  return (
    <div className="comms-line">
      <span className="line-ts">{hhmmss(line.ts)}</span>
      <span className="line-text">
        <HighlightedText line={line} />
      </span>
    </div>
  )
})

export function CommsPanel() {
  const mvComms = useMovable('comms')
  const { commsOpen, commsChannel, transcripts, commsConfig, scenario, commsAll, commsSource } = useAppSlice((s) => ({ commsOpen: s.commsOpen, commsChannel: s.commsChannel, transcripts: s.transcripts, commsConfig: s.commsConfig, scenario: s.scenario, commsAll: s.commsAll, commsSource: s.commsSource }))
  // Prompt 12 — the visibility policy can restrict a coordinating profile to
  // the merged command view (no per-channel tactical audio). Hot-reloads.
  const allChannels = radioChannelsAllowed(useProfile(), usePolicy())
  useEffect(() => {
    if (!allChannels && scenario?.loaded && !commsAll) setAppState({ commsAll: true })
    // Outside scenario mode the body renders transcripts[commsChannel] — a
    // previously selected per-agency channel must clamp back to command.
    if (!allChannels && !scenario?.loaded && commsChannel !== 'fdny') setAppState({ commsChannel: 'fdny' })
  }, [allChannels, scenario?.loaded, commsAll, commsChannel])
  const scrollRef = useRef<HTMLDivElement>(null)
  const scenarioMode = !!scenario

  // Merged "command view": every scenario channel interleaved by timestamp.
  // Memoized AND gated on commsAll — cloning + sorting up to 1200 lines on
  // every store write (even with the panel collapsed) was pure GC churn.
  const merged: TranscriptLine[] = useMemo(() => {
    if (!scenarioMode || !commsAll) return []
    return SCENARIO_CHANNELS.flatMap((c) => transcripts[c.id].map((l) => ({ ...l, text: `[${c.label}] ${l.text}` })))
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .slice(-200)
  }, [scenarioMode, commsAll, transcripts])

  useEffect(() => {
    // fetch channel config once; a real attached feed defaults the source
    // selector to LIVE, keyless installs default to SIMULATED.
    if (!commsConfig) {
      fetch('/api/comms/config')
        .then((r) => r.json())
        .then((cfg: { live: boolean; audioUrl: string }) =>
          setAppState({ commsConfig: cfg, commsSource: cfg.live ? 'live' : 'sim' }),
        )
        .catch(() => undefined)
    }
  }, [commsConfig])

  // Live playback requires BOTH: the operator selected LIVE and the server
  // actually has a feed attached. Keyless installs are always simulated.
  const liveAttached = commsConfig?.live ?? false
  const liveSelected = commsSource === 'live' && liveAttached
  // SIM mode shows only simulated content: live-transcribed lines are
  // filtered out rather than mislabeled under the SIMULATED watermark.
  // (Keyless installs are unaffected — all their lines are non-live.)
  // Memoized: a fresh array identity every render would defeat the row memo.
  const fdnySim = useMemo(() => transcripts.fdny.filter((l) => !l.live), [transcripts.fdny])
  const lines =
    scenarioMode && commsAll ? merged : commsChannel === 'fdny' && !liveSelected ? fdnySim : transcripts[commsChannel]
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length, commsChannel, commsOpen])

  // Pinned to the bottom AT ALL TIMES (user request) — the citywide radio
  // picture matters before any incident is stood up, too.
  if (!commsOpen) {
    return (
      <button className="comms-collapsed glass" onClick={() => setAppState({ commsOpen: true })}>
        COMMS ▴
      </button>
    )
  }

  // Honest badge: trust what the transcription pipeline actually delivers
  // (the sidecar falls back to the bundled recording if the live URL fails).
  const fdnyLines = transcripts.fdny
  const fdnyActuallyLive = fdnyLines.length ? fdnyLines[fdnyLines.length - 1].live : liveAttached
  // SIMULATED watermark covers the scripted channels always, and FDNY unless
  // the operator selected LIVE *and* the lines on screen are actually live —
  // a sidecar that fell back to the bundled recording stays watermarked.
  const isSim = commsChannel !== 'fdny' || !liveSelected || !fdnyActuallyLive
  const audioSrc = liveSelected ? commsConfig!.audioUrl : '/api/audio/fdny-dispatch-demo.mp3'

  return (
    <section {...mvComms} className="comms-panel glass">
      <div className="comms-tabs">
        {!allChannels && (
          <span className="comms-policy-note" title="Per-channel radio is restricted for this profile (visibility policy)">
            COMMAND VIEW ONLY · POLICY
          </span>
        )}
        {(allChannels ? (scenarioMode ? SCENARIO_CHANNELS : CHANNELS) : scenarioMode ? [] : CHANNELS.slice(0, 1)).map((c) => (
          <button
            key={c.id}
            className={`comms-tab${!commsAll && commsChannel === c.id ? ' on' : ''}`}
            onClick={() => setAppState({ commsChannel: c.id, commsAll: false })}
          >
            {c.label}
            {scenarioMode ? (
              <i className="tab-badge sim">DRILL</i>
            ) : c.id === 'fdny' ? (
              <i className={`tab-badge${liveSelected && fdnyActuallyLive ? ' live' : ' sim'}`}>
                {liveSelected ? (fdnyActuallyLive ? 'LIVE' : 'AS-LIVE') : 'SIM'}
              </i>
            ) : (
              <i className="tab-badge sim">SIM</i>
            )}
          </button>
        ))}
        {scenarioMode && (
          <button
            className={`comms-tab${commsAll ? ' on' : ''}`}
            onClick={() => setAppState({ commsAll: true })}
            title="Merged command view — every channel interleaved"
          >
            ALL
          </button>
        )}
        {!scenarioMode && (
          <span className="comms-source" aria-label="Comms source">
            <button
              className={`source-btn${!liveSelected ? ' on' : ''}`}
              aria-pressed={!liveSelected}
              onClick={() => setAppState({ commsSource: 'sim' })}
              title="Simulated comms for demos and training — bundled dispatch recording replayed as-if-live, scripted mutual-aid channels"
            >
              SIM
            </button>
            {/* aria-disabled (not disabled) keeps the button keyboard-reachable
                so its explanation is discoverable; the onClick guard makes it
                inert. */}
            <button
              className={`source-btn${liveSelected ? ' on' : ''}${liveAttached ? '' : ' disabled'}`}
              aria-pressed={liveSelected}
              aria-disabled={!liveAttached}
              onClick={() => {
                if (liveAttached) setAppState({ commsSource: 'live' })
              }}
              title={
                liveAttached
                  ? 'Live radio feed attached — play the real stream'
                  : 'No live feed attached — set BROADCASTIFY_URL in .env to enable'
              }
            >
              LIVE
            </button>
          </span>
        )}
        {commsChannel === 'fdny' && commsConfig && (
          <audio
            // Remount on source change — browsers don't reliably reload an
            // <audio> element when only its src attribute swaps.
            key={audioSrc}
            className="comms-audio"
            controls
            loop={!liveSelected}
            src={audioSrc}
            onError={() => {
              // A LIVE playback failure falls back to the simulated source —
              // but commsConfig.live stays true: the feed being ATTACHED is a
              // server fact, and one transient 502 must not grey out LIVE for
              // the whole session. Re-selecting LIVE simply retries the
              // stream. (A hiccup on the bundled demo file changes nothing.)
              if (!liveSelected) return
              setAppState({ commsSource: 'sim' })
            }}
          />
        )}
        <button className="panel-close" onClick={() => setAppState({ commsOpen: false })}>
          ▾
        </button>
      </div>
      <div className={`comms-scroll${isSim ? ' sim' : ''}`} ref={scrollRef}>
        {isSim && <span className="comms-watermark">SIMULATED</span>}
        {lines.length === 0 && (
          <div className="roster-empty">
            {commsChannel === 'fdny' && !liveSelected && liveAttached && transcripts.fdny.length > 0
              ? 'TRANSCRIBER IS ON THE LIVE FEED — SIM MODE PLAYS THE DEMO AUDIO ONLY'
              : 'AWAITING TRAFFIC…'}
          </div>
        )}
        {lines.map((l) => (
          // Server-minted line id; the ts|full-text fallback only serves lines
          // from an id-less server during dev HMR. Same-ms same-prefix lines
          // are routine (whisper bursts), so truncated text must never key.
          <CommsLine key={l.id ?? `${l.ts}|${l.text}`} line={l} />
        ))}
      </div>
    </section>
  )
}
