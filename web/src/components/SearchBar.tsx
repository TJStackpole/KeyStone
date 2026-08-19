import { useEffect, useRef, useState } from 'react'
import { autocompleteAddress } from '../api/geosearch'
import { standUpIncident } from '../actions'
import { setAppState, useAppSlice } from '../state/store'
import type { GeoHit } from '../types'
import { useNextStep } from '../lib/guidance'
import { tryVoiceCommand } from '../lib/voiceCommands'
import { notify } from './NoticeChip'

// Speech engines often return house numbers as WORDS ("one hundred gold
// street") which GeoSearch won't match — fold a leading run of number words
// into digits so the spoken address autocompletes like a typed one.
const NUM_WORDS: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000,
}

function normalizeSpoken(text: string): string {
  const cleaned = text.replace(/[.,!?]+\s*$/, '').trim()
  const tokens = cleaned.split(/\s+/).flatMap((t) => t.split('-'))
  // Spoken house numbers are POSITIONAL, not additive: "one twenty three" is
  // 123 (not 1+20+3=24) and "one oh five" is 105. Parse standard number
  // GROUPS ("twenty six" = 26, "six hundred forty two" = 642, "two thousand
  // five hundred" = 2500) and digit-CONCATENATE across group restarts.
  const groups: string[] = []
  let cur = 0 // current group value (units/tens/teens under multipliers)
  let total = 0 // current group total (thousands/hundreds folded in)
  let open = false
  let lastMag: 'unit' | 'teen' | 'tens' | 'mult' | 'oh' | null = null
  const closeGroup = () => {
    if (!open) return
    groups.push(String(total + cur))
    cur = 0
    total = 0
    open = false
    lastMag = null
  }
  let consumed = 0
  for (const tok of tokens) {
    const n = NUM_WORDS[tok.toLowerCase()]
    if (n === undefined) break
    consumed++
    if (n === 0) {
      // "oh"/"zero" is a literal digit placeholder — its own group.
      closeGroup()
      groups.push('0')
      continue
    }
    if (n === 100 || n === 1000) {
      cur = Math.max(1, cur) * n
      total += cur
      cur = 0
      open = true
      lastMag = 'mult'
      continue
    }
    const mag: 'unit' | 'teen' | 'tens' = n < 10 ? 'unit' : n < 20 ? 'teen' : 'tens'
    // Group RESTART: a unit can only follow tens within a group; anything
    // else after a completed word starts a new positional group.
    const extendsGroup = !open || lastMag === 'mult' || (lastMag === 'tens' && mag === 'unit')
    if (!extendsGroup) closeGroup()
    cur += n
    open = true
    lastMag = mag
  }
  closeGroup()
  const value = groups.join('')
  if (consumed > 0 && value.length > 0 && Number(value) > 0 && consumed < tokens.length) {
    return `${value} ${tokens.slice(consumed).join(' ')}`
  }
  return cleaned
}

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
  const searchNext = useNextStep() === 'search'
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<GeoHit[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [failed, setFailed] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  // Tap-a-building fills the search with that address (one Enter away from a
  // new incident there).
  const { searchPrefill } = useAppSlice((s) => ({ searchPrefill: s.searchPrefill }))
  useEffect(() => {
    if (!searchPrefill) return
    setAppState({ searchPrefill: null })
    // Focus FIRST: the focus event dispatches synchronously into the current
    // render's onFocus (which still sees the old hits) — queuing its stale
    // setOpen(true) BEFORE the clears below means the clears win the batch.
    inputRef.current?.focus()
    // Drop the previous query's results — stale rows would make Enter (during
    // the fetch window) stand up an incident at the WRONG address.
    setHits([])
    setOpen(false)
    setActive(0)
    onChange(searchPrefill)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchPrefill])

  function onChange(value: string) {
    setQuery(value)
    setFailed(false)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (value.trim().length < 2) {
      // Abort any in-flight request too — its late resolution would reopen
      // the dropdown with results for text the operator already deleted.
      abortRef.current?.abort()
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
        if (ac.signal.aborted) return
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
    // Kill anything still in flight: a pending debounce timer or fetch that
    // resolves AFTER the pick would pop the dropdown back open over the
    // fly-in — and a habit Enter would then stand up a second incident.
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = null
    abortRef.current?.abort()
    abortRef.current = null
    setHits([])
    setOpen(false)
    setQuery(hit.label)
    inputRef.current?.blur() // frees SPACE for push-to-talk right away
    void standUpIncident(hit)
  }

  // ------------------------- voice input (keyless) --------------------------
  // Browser SpeechRecognition: press the mic, speak the address, the live
  // transcript feeds the same autocomplete as typing.
  const [listening, setListening] = useState(false)
  const recRef = useRef<{ stop: () => void } | null>(null)
  const SpeechRec = (
    window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }
  ).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition

  function toggleMic() {
    if (listening) {
      recRef.current?.stop()
      return
    }
    if (!SpeechRec) return
    interface RecResult {
      results: ArrayLike<ArrayLike<{ transcript: string }>>
    }
    const rec = new (SpeechRec as new () => {
      lang: string
      interimResults: boolean
      maxAlternatives: number
      onresult: ((e: RecResult) => void) | null
      onend: (() => void) | null
      onerror: ((e: { error?: string }) => void) | null
      start: () => void
      stop: () => void
    })()
    rec.lang = 'en-US'
    rec.interimResults = true
    rec.maxAlternatives = 1
    rec.onresult = (e) => {
      const transcript = Array.from(e.results, (r) => r[0]?.transcript ?? '').join(' ').trim()
      if (!transcript) return
      // Voice VERBS first ("isolate", "north side", "floor four", "undo",
      // "brief") — but only on a FINAL result: interim fragments like
      // "north" mid-sentence must never fire a camera command.
      const isFinal = Array.from(e.results as ArrayLike<{ isFinal?: boolean }>).every((r) => r.isFinal !== false)
      const command = isFinal ? tryVoiceCommand(transcript) : null
      if (command) {
        notify(`VOICE · ${command}`)
        rec.onresult = null // stop() flushes one more final — never re-fire the verb
        rec.stop()
        return
      }
      // Normalized ("one hundred gold street" -> "100 gold street") so the
      // suggestion list fills exactly as if the address had been typed.
      onChange(normalizeSpoken(transcript))
    }
    rec.onend = () => setListening(false)
    rec.onerror = (e: { error?: string }) => {
      setListening(false)
      // A dead mic button with no message reads as a broken product.
      const code = e?.error ?? ''
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        notify('MICROPHONE BLOCKED — allow mic access in the browser address bar', 'red')
      } else if (code && code !== 'no-speech' && code !== 'aborted') {
        notify('VOICE INPUT UNAVAILABLE IN THIS BROWSER — type the address instead')
      }
    }
    recRef.current = rec
    rec.start()
    setListening(true)
    // Keep the keyboard armed for the spoken results: without this, focus
    // stays on the mic button and Enter re-toggles the mic instead of
    // selecting the highlighted address.
    inputRef.current?.focus()
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
    <div className={`searchwrap${searchNext ? ' pulse-hint' : ''}`} ref={wrapRef}>
      <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        ref={inputRef}
        className="search-input"
        value={query}
        placeholder="SEARCH NYC ADDRESS — e.g. 100 Gold Street"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => hits.length && setOpen(true)}
      />
      {!!SpeechRec && (
        <button
          className={`mic-btn${listening ? ' on' : ''}`}
          onClick={toggleMic}
          title={listening ? 'Stop listening' : 'Speak an address'}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
        </button>
      )}
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
