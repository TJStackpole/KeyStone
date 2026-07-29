const R_EARTH_M = 6371008.8
const DEG = Math.PI / 180

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG
  const dLon = (lon2 - lon1) * DEG
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2
  return 2 * R_EARTH_M * Math.asin(Math.sqrt(a))
}

/** Initial bearing from point 1 to point 2, degrees true [0, 360). */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin((lon2 - lon1) * DEG) * Math.cos(lat2 * DEG)
  const x =
    Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) -
    Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos((lon2 - lon1) * DEG)
  return ((Math.atan2(y, x) / DEG) + 360) % 360
}

/** Destination point given start, bearing (deg true) and distance (m). */
export function destination(lat: number, lon: number, bearing: number, distanceM: number): { lat: number; lon: number } {
  const δ = distanceM / R_EARTH_M
  const θ = bearing * DEG
  const φ1 = lat * DEG
  const λ1 = lon * DEG
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return { lat: φ2 / DEG, lon: (((λ2 / DEG) + 540) % 360) - 180 }
}

export interface PathPoint {
  lat: number
  lon: number
}

/**
 * A polyline with precomputed cumulative distances, supporting "position after
 * traveling d meters" queries — the movement engine's core primitive.
 */
export class Polyline {
  readonly points: PathPoint[]
  private cum: number[] = [0]
  readonly totalM: number

  constructor(points: PathPoint[]) {
    this.points = points.length >= 2 ? points : [...points, ...points]
    for (let i = 1; i < this.points.length; i++) {
      const p = this.points[i - 1]
      const q = this.points[i]
      this.cum.push(this.cum[i - 1] + haversineMeters(p.lat, p.lon, q.lat, q.lon))
    }
    this.totalM = this.cum[this.cum.length - 1]
  }

  /** Position + course after traveling `d` meters from the start (clamped). */
  at(d: number): { lat: number; lon: number; course: number } {
    const points = this.points
    if (d <= 0) {
      const c = bearingDeg(points[0].lat, points[0].lon, points[1].lat, points[1].lon)
      return { ...points[0], course: c }
    }
    if (d >= this.totalM) {
      const n = points.length
      const c = bearingDeg(points[n - 2].lat, points[n - 2].lon, points[n - 1].lat, points[n - 1].lon)
      return { ...points[n - 1], course: c }
    }
    let i = 1
    while (this.cum[i] < d) i++
    const p = points[i - 1]
    const q = points[i]
    const segLen = this.cum[i] - this.cum[i - 1]
    const t = segLen > 0 ? (d - this.cum[i - 1]) / segLen : 0
    return {
      lat: p.lat + (q.lat - p.lat) * t,
      lon: p.lon + (q.lon - p.lon) * t,
      course: bearingDeg(p.lat, p.lon, q.lat, q.lon),
    }
  }
}
