import { useAppState } from '../state/store'

// ---------------------------------------------------------------------------
// Module 4 — wind-impacted fire advisory. Fires when live NWS wind exceeds
// the wind-driven-fire threshold AND a fire floor is known. ADVISORY ONLY:
// no fire-spread prediction; the IC must confirm windward-face exposure.
// Doctrine basis: Training Bulletins — Fire Dynamics Ch. 4 (wind-impacted
// fires). The numeric trigger is an estimate — VALIDATE—SME.
// ---------------------------------------------------------------------------

/** ~20 mph sustained — configurable estimate, VALIDATE—SME. */
export const WIND_DRIVEN_KT = 17

export function WindAdvisory() {
  const { wind, incident, timeline } = useAppState()
  if (!wind || !incident || wind.speedKt < WIND_DRIVEN_KT) return null
  let fireFloor: number | null = null
  for (let i = timeline.length - 1; i >= 0; i--) {
    const ev = timeline[i]
    if (ev.kind === 'sim.dispatched') {
      const p = (ev.payload ?? {}) as { fireFloor?: number; incidentId?: string }
      if (p.incidentId === incident.id && typeof p.fireFloor === 'number') fireFloor = p.fireFloor
      break
    }
  }
  if (fireFloor === null) return null
  return (
    <div className="wind-advisory">
      <b>⚠ WIND-IMPACTED FIRE RISK</b>
      <span>
        {wind.speedKt} kt{wind.gustKt ? ` (G${wind.gustKt})` : ''} from {wind.fromDeg}° with fire on FL {fireFloor} —
        confirm windward-face exposure before interior attack.
      </span>
      <i>Doctrine: Training Bulletins · Fire Dynamics Ch. 4 · trigger {WIND_DRIVEN_KT} kt VALIDATE—SME</i>
    </div>
  )
}
