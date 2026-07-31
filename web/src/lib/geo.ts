const R_EARTH_M = 6371008.8
const FT_TO_M = 0.3048

export function feetToMeters(ft: number): number {
  return ft * FT_TO_M
}

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad
  const dLon = (lon2 - lon1) * toRad
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * R_EARTH_M * Math.asin(Math.sqrt(a))
}

export function formatMeters(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`
}

/**
 * Nearest point on the ring's edges to (lon, lat), planar-approximated with a
 * cos(lat) x-scale (fine at building scale). Ring is [lon, lat][].
 */
export function nearestOnRing(lon: number, lat: number, ring: number[][]): [number, number] {
  const cosLat = Math.cos((lat * Math.PI) / 180)
  let best: [number, number] = [ring[0][0], ring[0][1]]
  let bestD2 = Infinity
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = ring[i]
    const [bx, by] = ring[i + 1]
    const abx = (bx - ax) * cosLat
    const aby = by - ay
    const apx = (lon - ax) * cosLat
    const apy = lat - ay
    const len2 = abx * abx + aby * aby || 1e-12
    const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2))
    const cx = ax + (bx - ax) * t
    const cy = ay + (by - ay) * t
    const dx = (lon - cx) * cosLat
    const dy = lat - cy
    const d2 = dx * dx + dy * dy
    if (d2 < bestD2) {
      bestD2 = d2
      best = [cx, cy]
    }
  }
  return best
}

/** Ray-cast (even-odd) point-in-ring test. Ring is [lon, lat][]; point is lon/lat degrees. */
export function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    // TOGGLE per crossing — even-odd. (`inside = true` here once made the test
    // pass for any point with a single eastward crossing, i.e. almost anything
    // west of the polygon: wrong lot/wing/building resolution on concave rings.)
    if (intersects) inside = !inside
  }
  return inside
}
