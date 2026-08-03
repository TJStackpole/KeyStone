import { useEffect, useState } from 'react'
import { hasCapability, useProfile } from '../profiles/manifest'
import { useAppSlice } from '../state/store'
import { fmtAge } from './FeedHealthPanel'

// ---------------------------------------------------------------------------
// #8 honest-data cues: every feed-derived readout carries its source and
// age, quietly. <DataAge/> is the shared chip; HarborChip is the first live
// readout wearing it — Battery water level with trend, straight off the
// NOAA CO-OPS feed, SIMULATED-labeled when a drill has mocked it.
// ---------------------------------------------------------------------------

export function DataAge({ at, attribution }: { at: number; attribution: string }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 10_000)
    return () => clearInterval(t)
  }, [])
  return (
    <span className="data-age" title={`Source: ${attribution} — data age ${fmtAge(Date.now() - at)}`}>
      {attribution} · {fmtAge(Date.now() - at)}
    </span>
  )
}

interface HarborStation {
  name: string
  waterLevelFt: number
  trend: 'rising' | 'falling' | 'steady'
  ratePerHrFt: number
}

const TREND_GLYPH = { rising: '↗', falling: '↘', steady: '→' } as const

/** Battery water-level chip: always on for NYCEM; FDNY sees it only when the
 *  incident type is water-related (coastal/flood context, per Prompt 13). */
export function HarborChip() {
  const profile = useProfile()
  const { water, incidentType } = useAppSlice((s) => ({
    water: s.feedData['noaa-water'],
    incidentType: s.incident?.type ?? null,
  }))
  if (!water || !hasCapability(profile, 'feeds.noaa-water')) return null
  const waterRelevant =
    profile === 'nycem' || (incidentType !== null && /flood|water|coastal|storm/i.test(incidentType))
  if (!waterRelevant) return null
  const battery = (water.payload as { stations?: HarborStation[] })?.stations?.find((st) => st.name === 'The Battery')
  if (!battery) return null
  return (
    <span
      className={`chip harbor-chip${battery.trend === 'rising' && battery.ratePerHrFt > 1 ? ' rising-fast' : ''}`}
      title={`Harbor water at The Battery: ${battery.waterLevelFt.toFixed(2)} ft, ${battery.trend} at ${Math.abs(battery.ratePerHrFt).toFixed(2)} ft/hr. Regional gauge — context, not scene-level.`}
    >
      BATTERY {battery.waterLevelFt.toFixed(1)}ft {TREND_GLYPH[battery.trend]}
      <DataAge at={water.at} attribution={water.attribution} />
    </span>
  )
}
