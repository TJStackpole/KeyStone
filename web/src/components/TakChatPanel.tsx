import { useEffect, useRef, useState } from 'react'
import { useMovable } from '../lib/movable'
import { setAppState, useAppSlice } from '../state/store'

// ---------------------------------------------------------------------------
// TAK GeoChat — the interagency comm architecture. The console speaks as OEM
// Watch Command into the broadcast room or any agency room (FDNY / NYPD /
// EMS / PAPD / OEM); simulated units post clearly-badged arrival traffic
// into their agency's room. Everything is genuine b-t-f CoT on the TAK
// server, so real ATAK phones see (and can answer) every message.
// ---------------------------------------------------------------------------

const ROOMS = [
  { id: 'All Chat Rooms', label: 'ALL' },
  { id: 'FDNY', label: 'FDNY' },
  { id: 'NYPD', label: 'NYPD' },
  { id: 'EMS', label: 'EMS' },
  { id: 'PAPD', label: 'PAPD' },
  { id: 'OEM', label: 'OEM' },
]

/**
 * TAK LINK moved out of the top bar: it lives on the bottom row next to the
 * COMMS panel. Green dot = link up (click for GeoChat); amber = link down.
 */
export function TakLinkButton() {
  const { takConnected, advanced } = useAppSlice((s) => ({ takConnected: s.takConnected, advanced: s.uiAdvanced }))
  if (!advanced) return null // COMMAND mode: TAK plumbing is an advanced surface
  if (takConnected === null) return null
  if (takConnected === false) {
    return (
      <span className="tak-link-btn glass offline" title="TAK server link is down — reconnecting">
        <span className="dot" /> TAK OFFLINE
      </span>
    )
  }
  return (
    <button
      className="tak-link-btn glass"
      onClick={() => setAppState((s) => ({ chatOpen: !s.chatOpen }))}
      title="TAK link is up — click for GeoChat with every unit on the server"
    >
      <span className="dot" /> TAK LINK
    </button>
  )
}

export function TakChatPanel() {
  const mvTakchat = useMovable('takchat')
  const { chatOpen, chats, takConnected } = useAppSlice((s) => ({ chatOpen: s.chatOpen, chats: s.chats, takConnected: s.takConnected }))
  const [room, setRoom] = useState('All Chat Rooms')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // The ALL tab is the OEM overview: every room's traffic, tagged by room.
  const visible = room === 'All Chat Rooms' ? chats : chats.filter((c) => c.room === room)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [visible.length, chatOpen, room])

  if (!chatOpen) return null

  const send = async () => {
    const text = draft.trim()
    if (!text) return
    setError(null)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, room }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? `send failed (${res.status})`)
        return
      }
      setDraft('')
    } catch {
      setError('server unreachable')
    }
  }

  const activeLabel = ROOMS.find((r) => r.id === room)?.label ?? 'ALL'

  return (
    <section {...mvTakchat} className="takchat-panel glass">
      <div className="panel-head">
        <span className="card-title">TAK Chat · OEM Watch Command</span>
        <span className={`chip${takConnected ? '' : ' warn'}`}>
          <span className="dot" /> {takConnected ? 'LIVE' : 'TAK OFFLINE'}
        </span>
        <button className="panel-close" onClick={() => setAppState({ chatOpen: false })}>
          ✕
        </button>
      </div>
      <div className="takchat-rooms">
        {ROOMS.map((r) => (
          <button
            key={r.id}
            className={`comms-tab${room === r.id ? ' on' : ''}`}
            onClick={() => setRoom(r.id)}
            title={r.id === 'All Chat Rooms' ? 'Every room, interleaved — the OEM overview' : `${r.label} agency room`}
          >
            {r.label}
          </button>
        ))}
      </div>
      <div className="takchat-scroll no-drag" ref={scrollRef}>
        {visible.length === 0 && (
          <div className="intel-note">
            {room === 'All Chat Rooms'
              ? 'NO TRAFFIC YET — MESSAGES REACH EVERY EUD ON THIS TAK SERVER'
              : `NO ${activeLabel} TRAFFIC YET`}
          </div>
        )}
        {visible.map((c) => (
          <div key={c.id} className={`chat-msg${c.self ? ' self' : ''}`}>
            <span className="chat-from">
              {c.self ? 'OEM WATCH CMD (YOU)' : c.from}
              {room === 'All Chat Rooms' && c.room !== 'All Chat Rooms' && (
                <i className="chat-room">{c.room}</i>
              )}
              {c.sim && <i className="chat-sim">SIM</i>}
            </span>
            <span className="chat-text">{c.text}</span>
            <span className="chat-ts">{new Date(c.ts).toTimeString().slice(0, 5)}</span>
          </div>
        ))}
      </div>
      {error && <div className="chat-error">{error}</div>}
      <div className="takchat-input">
        <input
          value={draft}
          maxLength={500}
          placeholder={
            takConnected
              ? room === 'All Chat Rooms'
                ? 'Message all units…'
                : `Message ${activeLabel} units…`
              : 'TAK link down'
          }
          disabled={!takConnected}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send()
          }}
        />
        <button disabled={!takConnected || !draft.trim()} onClick={() => void send()}>
          SEND
        </button>
      </div>
    </section>
  )
}
