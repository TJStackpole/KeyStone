import { destination } from '../lib/geo.js'
import { fetchFirehousesNear, type Firehouse } from '../nyc.js'
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

  const units: UnitSpec[] = []
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
  units.push({ ...synthetic('UAS-1', 'drone', lat, lon, 900, 15, 250), hae: 80 })
  units.push({ ...synthetic('UAS-2', 'drone', lat, lon, 1200, 15, 120), hae: 115 })

  return units
}

function synthetic(
  callsign: string,
  category: UnitCategory,
  lat: number,
  lon: number,
  distanceM: number,
  speedMps: number,
  bearing?: number,
): UnitSpec {
  const b = bearing ?? Math.floor(Math.random() * 360)
  return { callsign, category, origin: destination(lat, lon, b, distanceM), speedMps }
}
