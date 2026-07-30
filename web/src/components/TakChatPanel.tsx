import { useEffect, useRef, useState } from 'react'
import { setAppState, useAppState } from '../state/store'

/**
 * TAK GeoChat — "All Chat Rooms" on the connected TAK server. Messages go
 * out as genuine b-t-f CoT, so every EUD (real ATAK phones included) sees
 * them and their replies land here. Opened from the TAK LINK chip.
 */
export function TakChatPanel() {
  const { chatOpen, chats, takConnected } = useAppState()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chats.length, chatOpen])

  if (!chatOpen) return null

  const send = async () => {
    const text = draft.trim()
    if (!text) return
    setError(null)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
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

  return (
    <section className="takchat-panel glass">
      <div className="panel-head">
        <span className="card-title">TAK Chat · All Chat Rooms</span>
        <span className={`chip${takConnected ? '' : ' warn'}`}>
          <span className="dot" /> {takConnected ? 'LIVE' : 'TAK OFFLINE'}
        </span>
        <button className="panel-close" onClick={() => setAppState({ chatOpen: false })}>
          ✕
        </button>
      </div>
      <div className="takchat-scroll" ref={scrollRef}>
        {chats.length === 0 && (
          <div className="intel-note">NO TRAFFIC YET — MESSAGES REACH EVERY EUD ON THIS TAK SERVER</div>
        )}
        {chats.map((c) => (
          <div key={c.id} className={`chat-msg${c.self ? ' self' : ''}`}>
            <span className="chat-from">{c.self ? 'KEYSTONE (YOU)' : c.from}</span>
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
          placeholder={takConnected ? 'Message all units…' : 'TAK link down'}
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
