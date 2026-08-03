import { destination, type PathPoint } from '../lib/geo.js'
import { countWetSamples, fetchFirehousesNear, isLand, type Firehouse } from '../nyc.js'
import type { UnitCategory } from '../tak/cot.js'

export interface UnitSpec {
  callsign: string
  category: UnitCategory
  origin: { lat: number; lon: number }
  /** Ground speed while enroute, m/s. */
  speedMps: number
  /** Cruise altitude for aircraft (hae, meters). */
  hae?: number
}

/**
 * Build a realistic first-alarm assignment for an incident:
 * 3 engines, 2 ladders, 1 battalion chief, 1 rescue, 2 EMS, 4 NYPD, 1 OEM,
 * 2 drones. FDNY companies are the REAL nearest companies dispatched from
 * their REAL firehouse locations (parsed from the FDNY Firehouse Listing);
 * EMS/NYPD/OEM originate at plausible offsets (their stations aren't in the
 * open dataset). Falls back to synthetic companies at offsets if Open Data is
 * unreachable — the demo must never dead-end.
 */
export async function buildFirstAlarm(lat: number, lon: number): Promise<UnitSpec[]> {
  let firehouses: Firehouse[] = []
  try {
    firehouses = await fetchFirehousesNear(lat, lon)
  } catch (err) {
    console.warn('[sim] firehouse data unavailable — using synthetic origins:', err)
  }

  // Synthetic origins resolve async (land-mask probes) — collected as
  // promises so all units validate concurrently, then awaited together.
  const units: (UnitSpec | Promise<UnitSpec>)[] = []
  const usedHouses = new Set<string>()

  const takeHouse = (pred: (f: Firehouse) => boolean): Firehouse | undefined => {
    const f = firehouses.find((fh) => pred(fh) && !usedHouses.has(fh.name))
    if (f) usedHouses.add(f.name)
    return f
  }

  // --- FDNY from real houses -------------------------------------------------
  for (let i = 0; i < 3; i++) {
    const house = takeHouse((f) => f.engines.length > 0)
    if (house) {
      units.push({
        callsign: `E-${house.engines[0]}`,
        category: 'engine',
        origin: { lat: house.lat, lon: house.lon },
        speedMps: 11,
      })
    } else {
      units.push(synthetic(`E-${90 + i}`, 'engine', lat, lon, 1200 + i * 400, 11))
    }
  }

  // Ladders may share a house with a dispatched engine — that's realistic
  // (E-4/L-15 roll together), so only dedupe against other ladders.
  const usedLadderHouses = new Set<string>()
  for (let i = 0; i < 2; i++) {
    const house = firehouses.find((f) => f.ladders.length > 0 && !usedLadderHouses.has(f.name))
    if (house) {
      usedLadderHouses.add(house.name)
      units.push({
        callsign: `L-${house.ladders[0]}`,
        category: 'ladder',
        origin: { lat: house.lat, lon: house.lon },
        speedMps: 10.5,
      })
    } else {
      units.push(synthetic(`L-${90 + i}`, 'ladder', lat, lon, 1500 + i * 500, 10.5))
    }
  }

  const bcHouse = firehouses.find((f) => f.battalions.length > 0)
  units.push(
    bcHouse
      ? {
          callsign: `BC-${bcHouse.battalions[0]}`,
          category: 'battalion',
          origin: { lat: bcHouse.lat, lon: bcHouse.lon },
          speedMps: 13,
        }
      : synthetic('BC-01', 'battalion', lat, lon, 1800, 13),
  )

  const rescueHouse = firehouses.find((f) => f.rescues.length > 0 || f.squads.length > 0)
  units.push(
    rescueHouse
      ? {
          callsign: rescueHouse.rescues.length
            ? `R-${rescueHouse.rescues[0]}`
            : `SQ-${rescueHouse.squads[0]}`,
          category: 'rescue',
          origin: { lat: rescueHouse.lat, lon: rescueHouse.lon },
          speedMps: 11,
        }
      : synthetic('R-1', 'rescue', lat, lon, 2600, 11),
  )

  // --- EMS / NYPD / OEM from plausible offsets -------------------------------
  units.push(synthetic('EMS-01', 'ems', lat, lon, 1400, 12, 305))
  units.push(synthetic('EMS-02', 'ems', lat, lon, 2100, 12, 40))
  for (let i = 0; i < 4; i++) {
    units.push(synthetic(`PD-${i + 1}`, 'nypd', lat, lon, 800 + i * 350, 14, 45 + i * 90))
  }
  units.push(synthetic('OEM-1', 'oem', lat, lon, 2400, 10, 200))

  // --- Drones: launch nearby, climb to altitude, orbit on arrival ------------
  units.push(synthetic('UAS-1', 'drone', lat, lon, 900, 15, 250).then((u) => ({ ...u, hae: 80 })))
  units.push(synthetic('UAS-2', 'drone', lat, lon, 1200, 15, 120).then((u) => ({ ...u, hae: 115 })))

  return Promise.all(units)
}

/** Escalation reinforcements: next-nearest real companies not already assigned. */
/** One escalation table for BOTH the live escalation and its preview —
 *  fork this and the RESOURCES page starts lying about the next alarm. */
export const ESCALATION_PLAN: Record<'all-hands' | '2nd' | '3rd' | '4th' | '5th', { e: number; l: number; bc: number }> = {
  'all-hands': { e: 1, l: 1, bc: 0 },
  '2nd': { e: 4, l: 2, bc: 1 },
  '3rd': { e: 4, l: 2, bc: 1 },
  '4th': { e: 4, l: 2, bc: 1 },
  '5th': { e: 4, l: 2, bc: 1 },
}

const ALARM_LADDER = ['10-75', 'all-hands', '2nd', '3rd', '4th', '5th'] as const

/** The next rung above the current alarm level (null at the top). */
export function nextAlarmLevel(current: string | undefined): (typeof ALARM_LADDER)[number] | null {
  const idx = ALARM_LADDER.indexOf((current ?? '10-75') as (typeof ALARM_LADDER)[number])
  return idx >= 0 && idx < ALARM_LADDER.length - 1 ? ALARM_LADDER[idx + 1] : null
}

export async function buildReinforcements(
  lat: number,
  lon: number,
  plan: { e: number; l: number; bc: number },
  assignedCallsigns: Set<string>,
): Promise<UnitSpec[]> {
  let firehouses: Firehouse[] = []
  try {
    firehouses = await fetchFirehousesNear(lat, lon)
  } catch {
    // fall through — synthetic reinforcements below
  }
  const units: (UnitSpec | Promise<UnitSpec>)[] = []

  const pick = (
    count: number,
    numbersOf: (f: Firehouse) => number[],
    prefix: string,
    category: UnitSpec['category'],
    speed: number,
  ) => {
    let found = 0
    for (const f of firehouses) {
      if (found >= count) break
      for (const n of numbersOf(f)) {
        const callsign = `${prefix}-${n}`
        if (assignedCallsigns.has(callsign)) continue
        assignedCallsigns.add(callsign)
        units.push({ callsign, category, origin: { lat: f.lat, lon: f.lon }, speedMps: speed })
        found++
        break
      }
    }
    // Deterministic synthetic fallback: walk up from 200 skipping anything
    // already assigned, so an alarm PREVIEW and the escalation that follows
    // name the exact same companies.
    for (let n = 200; found < count; n++) {
      const callsign = `${prefix}-${n}`
      if (assignedCallsigns.has(callsign)) continue
      assignedCallsigns.add(callsign)
      units.push(synthetic(callsign, category, lat, lon, 2500 + found * 600, speed))
      found++
    }
  }

  pick(plan.e, (f) => f.engines, 'E', 'engine', 11)
  pick(plan.l, (f) => f.ladders, 'L', 'ladder', 10.5)
  if (plan.bc > 0) pick(plan.bc, (f) => f.battalions, 'BC', 'battalion', 13)
  return Promise.all(units)
}

async function synthetic(
  callsign: string,
  category: UnitCategory,
  lat: number,
  lon: number,
  distanceM: number,
  speedMps: number,
  bearing?: number,
): Promise<UnitSpec> {
  const b = bearing ?? Math.floor(Math.random() * 360)
  return { callsign, category, origin: await landOrigin(lat, lon, b, distanceM), speedMps }
}

/**
 * Spawn point `distanceM` out on a bearing near `preferred` that is (a) on
 * land and (b) on the same shore — its straight chord back to the incident
 * never crosses water — so waterfront incidents (100 Gold St) don't get units
 * materializing in the East River or routed across it. Sweeps outward from
 * the preferred bearing in 30° steps; if no candidate has a dry chord, takes
 * the first land candidate (a real router can still bridge from there); if
 * the whole ring is wet, degrades to a short offset from the incident block,
 * which is known land.
 */
async function landOrigin(
  incLat: number,
  incLon: number,
  preferred: number,
  distanceM: number,
): Promise<PathPoint> {
  let firstLand: PathPoint | null = null
  for (const delta of [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180]) {
    const p = destination(incLat, incLon, (preferred + delta + 360) % 360, distanceM)
    if (!(await isLand(p.lat, p.lon))) continue
    if ((await countWetSamples([p, { lat: incLat, lon: incLon }])) === 0) return p
    firstLand ??= p
  }
  return firstLand ?? destination(incLat, incLon, preferred, 150)
}
