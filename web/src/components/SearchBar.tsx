import { useEffect, useRef, useState } from 'react'
import { autocompleteAddress } from '../api/geosearch'
import { standUpIncident } from '../actions'
import { setAppState, useAppState } from '../state/store'
import type { GeoHit } from '../types'

/** Bold the query tokens inside a suggestion, Google-Maps-style. */
function Highlight({ text, query }: { text: string; query: string }) {
  const tokens = query.trim().split(/\s+/).filter((t) => t.length >= 1)
  if (!tokens.length) return <>{text}</>
  const re = new RegExp(`(${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  const lower = tokens.map((t) => t.toLowerCase())
  // NOTE: split(re) keeps the captured matches as segments; a segment is a
  // match iff it equals one of the tokens. (Never re.test() a /g regex per
  // segment — its stateful lastIndex silently skips alternating matches.)
  return (
    <>
      {text.split(re).map((seg, i) =>
        lower.includes(seg.toLowerCase()) ? <b key={i}>{seg}</b> : <span key={i}>{seg}</span>,
      )}
    </>
  )
}

export function SearchBar() {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<GeoHit[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [failed, setFailed] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  // Tap-a-building fills the search with that address (one Enter away from a
  // new incident there).
  const { searchPrefill } = useAppState()
  useEffect(() => {
    if (!searchPrefill) return
    setAppState({ searchPrefill: null })
    onChange(searchPrefill)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchPrefill])

  function onChange(value: string) {
    setQuery(value)
    setFailed(false)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (value.trim().length < 2) {
      setHits([])
      setOpen(false)
      return
    }
    debounceRef.current = setTimeout(async () => {
      abortRef.current?.abort()
      const ac = new AbortController()
      abortRef.current = ac
      try {
        const results = await autocompleteAddress(value, ac.signal)
        setHits(results)
        setActive(0)
        setOpen(true)
      } catch (err) {
        if (!ac.signal.aborted) {
          console.error('[geosearch] unavailable:', err)
          setHits([])
          setFailed(true)
          setOpen(true)
        }
      }
    }, 220)
  }

  function select(hit: GeoHit) {
    setOpen(false)
    setQuery(hit.label)
    void standUpIncident(hit)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open || (!hits.length && !failed)) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, hits.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter' && hits[active]) {
      e.preventDefault()
      select(hits[active])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="searchwrap" ref={wrapRef}>
      <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        className="search-input"
        value={query}
        placeholder="SEARCH NYC ADDRESS — e.g. 100 Gold Street"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => hits.length && setOpen(true)}
      />
      {open && (
        <div className="search-dropdown glass">
          {failed && <div className="search-empty">GEOSEARCH UNAVAILABLE — CHECK NETWORK</div>}
          {!failed && !hits.length && <div className="search-empty">NO NYC MATCHES</div>}
          {hits.map((h, i) => (
            <div
              key={`${h.label}-${i}`}
              className={`search-hit${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                select(h)
              }}
            >
              <svg className="hit-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1 1 16 0Z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
              <span className="hit-main">
                <span className="addr">
                  <Highlight text={h.name || h.label} query={query} />
                </span>
                <span className="hit-sub">
                  {[h.neighbourhood, h.borough].filter(Boolean).join(' · ') || 'New York City'}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
