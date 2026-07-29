import { useEffect, useRef, useState } from 'react'
import { autocompleteAddress } from '../api/geosearch'
import { standUpIncident } from '../actions'
import type { GeoHit } from '../types'

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

  function onChange(value: string) {
    setQuery(value)
    setFailed(false)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (value.trim().length < 3) {
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
              <span className="addr">{h.label}</span>
              <span className="boro">{h.borough ?? ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
