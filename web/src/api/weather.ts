// ---------------------------------------------------------------------------
// Module 4 — live wind from the National Weather Service (api.weather.gov):
// free, keyless, CORS-open. Two hops: point metadata -> nearest observation
// station -> latest observation.
// ---------------------------------------------------------------------------

export interface WindObs {
  /** Sustained wind, knots. */
  speedKt: number
  /** Gusts, knots (null when not reported). */
  gustKt: number | null
  /** Meteorological direction the wind blows FROM, degrees true. */
  fromDeg: number
  stationId: string
  stationName: string
  observedAt: string
}

const kmhToKt = (kmh: number) => kmh * 0.539957

export async function fetchWind(lat: number, lon: number, signal?: AbortSignal): Promise<WindObs | null> {
  const point = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, { signal })
  if (!point.ok) throw new Error(`NWS points ${point.status}`)
  const pointBody = (await point.json()) as { properties?: { observationStations?: string } }
  const stationsUrl = pointBody.properties?.observationStations
  if (!stationsUrl) return null
  const stations = await fetch(stationsUrl, { signal })
  if (!stations.ok) throw new Error(`NWS stations ${stations.status}`)
  const stationsBody = (await stations.json()) as {
    features?: { properties?: { stationIdentifier?: string; name?: string } }[]
  }
  // Nearest stations first; sparse observations (nulled wind fields) are
  // routine — walk down the list until one actually reports wind.
  const candidates = (stationsBody.features ?? []).slice(0, 4)
  for (const feature of candidates) {
    const st = feature.properties
    if (!st?.stationIdentifier) continue
    const obs = await fetch(`https://api.weather.gov/stations/${st.stationIdentifier}/observations/latest`, { signal })
    if (!obs.ok) continue
    const obsBody = (await obs.json()) as {
      properties?: {
        timestamp?: string
        windSpeed?: { value: number | null }
        windGust?: { value: number | null }
        windDirection?: { value: number | null }
      }
    }
    const p = obsBody.properties
    if (!p || p.windSpeed?.value == null) continue
    const speedKt = Math.round(kmhToKt(p.windSpeed.value))
    // Calm reports legitimately omit direction.
    if (p.windDirection?.value == null && speedKt > 3) continue
    return {
      speedKt,
      gustKt: p.windGust?.value != null ? Math.round(kmhToKt(p.windGust.value)) : null,
      fromDeg: Math.round(p.windDirection?.value ?? 0),
      stationId: st.stationIdentifier,
      stationName: st.name ?? st.stationIdentifier,
      observedAt: p.timestamp ?? new Date().toISOString(),
    }
  }
  return null
}
