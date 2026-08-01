import { useEffect, useMemo, useState } from 'react'
import { classifyBuilding, FFP_TITLES, type FfpType } from '../lib/ffpClassify'
import { setAppState, useAppSlice } from '../state/store'

// ---------------------------------------------------------------------------
// Module 3 — Building-Type Tactics Engine. Shows the FFP classification
// (public-data heuristic: confidence + the raw attributes behind it, with a
// one-tap IC override that logs), and the pre-generated, per-item-cited
// Tactics Card for the effective type. Checking an item logs to the
// incident timeline.
// ---------------------------------------------------------------------------

interface CardItem {
  text: string
  book: string
  doc: string
  page: number
  validateSme?: boolean
}

interface TacticsCard {
  type: string
  title: string
  doctrineRef: string
  hazards: CardItem[]
  engineDuties: CardItem[]
  ladderDuties: CardItem[]
  failureModes: CardItem[]
}

const SECTIONS: { key: keyof Pick<TacticsCard, 'hazards' | 'engineDuties' | 'ladderDuties' | 'failureModes'>; label: string }[] = [
  { key: 'hazards', label: 'TYPE-SPECIFIC HAZARDS' },
  { key: 'engineDuties', label: 'FIRST-ALARM ENGINE DUTIES' },
  { key: 'ladderDuties', label: 'FIRST-ALARM LADDER DUTIES' },
  { key: 'failureModes', label: 'KNOWN FAILURE MODES' },
]

async function logTimeline(kind: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch('/api/timeline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, payload }),
    })
  } catch {
    // timeline logging must never block tactics use
  }
}

export function TacticsPanel() {
  const { tacticsOpen, tacticsOverride, incident, intel, targetHeightM } = useAppSlice((s) => ({ tacticsOpen: s.tacticsOpen, tacticsOverride: s.tacticsOverride, incident: s.incident, intel: s.intel, targetHeightM: s.targetHeightM }))
  const [card, setCard] = useState<TacticsCard | null>(null)
  const [cardState, setCardState] = useState<'idle' | 'loading' | 'missing'>('idle')
  const [checked, setChecked] = useState<Set<string>>(new Set())

  const classification = useMemo(
    () => classifyBuilding(intel.pluto, targetHeightM),
    [intel.pluto, targetHeightM],
  )
  const effectiveType: FfpType = tacticsOverride ?? classification.type

  useEffect(() => {
    if (!tacticsOpen || effectiveType === 'unclassified') {
      setCard(null)
      return
    }
    let stale = false
    setCardState('loading')
    fetch(`/api/tactics/${effectiveType}`)
      .then(async (r) => {
        if (stale) return
        if (!r.ok) {
          setCard(null)
          setCardState('missing')
          return
        }
        setCard((await r.json()) as TacticsCard)
        setCardState('idle')
      })
      .catch(() => {
        if (!stale) {
          setCard(null)
          setCardState('missing')
        }
      })
    return () => {
      stale = true
    }
  }, [tacticsOpen, effectiveType])

  if (!tacticsOpen || !incident) return null

  const toggleCheck = (section: string, item: CardItem) => {
    const id = `${section}:${item.text.slice(0, 60)}`
    const next = new Set(checked)
    const nowChecked = !next.has(id)
    if (nowChecked) next.add(id)
    else next.delete(id)
    setChecked(next)
    void logTimeline('tactics.checked', {
      type: effectiveType,
      section,
      done: nowChecked,
      item: item.text.slice(0, 100),
      cite: `${item.book} · ${item.doc} · p.${item.page}`,
    })
  }

  const override = (t: string) => {
    const type = (t || null) as FfpType | null
    setAppState({ tacticsOverride: type })
    void logTimeline('tactics.override', {
      from: classification.type,
      to: type ?? '(auto)',
      basis: classification.basis.join('; '),
    })
  }

  return (
    <section className="tactics-panel glass">
      <div className="panel-head">
        <span className="card-title">Building-Type Tactics</span>
        <span className="chip warn">
          <span className="dot" /> VALIDATE — SME
        </span>
        <button className="panel-close" onClick={() => setAppState({ tacticsOpen: false })}>
          ✕
        </button>
      </div>
      <div className="tactics-class">
        <div className="tactics-class-row">
          <b>{FFP_TITLES[effectiveType]}</b>
          <span className={`conf conf-${classification.confidence}`}>
            {tacticsOverride ? 'IC OVERRIDE' : `${classification.confidence.toUpperCase()} CONFIDENCE`}
          </span>
        </div>
        <div className="tactics-basis">{classification.basis.join(' · ')}</div>
        <div className="tactics-basis">
          Public-data heuristic mapped to FFP Vol. 1 building types — not CIDS.
        </div>
        <select value={tacticsOverride ?? ''} onChange={(e) => override(e.target.value)} title="IC override — logged to the timeline">
          <option value="">Auto: {FFP_TITLES[classification.type]}</option>
          {(Object.keys(FFP_TITLES) as FfpType[])
            .filter((t) => t !== 'unclassified')
            .map((t) => (
              <option key={t} value={t}>
                Override: {FFP_TITLES[t]}
              </option>
            ))}
        </select>
      </div>
      <div className="tactics-scroll">
        {effectiveType === 'unclassified' && (
          <div className="intel-note warn-note">NO CLASSIFICATION FROM PUBLIC DATA — SELECT A TYPE ABOVE</div>
        )}
        {cardState === 'missing' && effectiveType !== 'unclassified' && (
          <div className="intel-note warn-note">
            NO TACTICS CARD GENERATED FOR THIS TYPE — RUN THE CARD BUILD ON THIS MACHINE
          </div>
        )}
        {card && (
          <>
            <div className="tactics-ref">
              DOCTRINE REF: <b>{card.doctrineRef}</b> — every item cites its source page
            </div>
            {SECTIONS.map((s) => {
              const items = card[s.key]
              if (!items?.length) return null
              return (
                <div key={s.key} className="tactics-section">
                  <div className="intel-section-title">{s.label}</div>
                  {items.map((item, i) => {
                    const id = `${s.key}:${item.text.slice(0, 60)}`
                    return (
                      <label key={i} className="tactics-item">
                        <input type="checkbox" checked={checked.has(id)} onChange={() => toggleCheck(s.key, item)} />
                        <span>
                          <span className="tactics-text">
                            {item.text}
                            {item.validateSme && <i className="sme-tag">VALIDATE—SME</i>}
                          </span>
                          <span className="tactics-cite">
                            {item.book} · {item.doc} · p.{item.page}
                          </span>
                        </span>
                      </label>
                    )
                  })}
                </div>
              )
            })}
          </>
        )}
      </div>
    </section>
  )
}
