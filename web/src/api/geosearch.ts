import type { GeoHit } from '../types'

const GEOSEARCH = 'https://geosearch.planninglabs.nyc/v2/autocomplete'

interface GeoSearchFeature {
  geometry: { type: 'Point'; coordinates: [number, number] }
  properties: {
    label?: string
    name?: string
    borough?: string
    neighbourhood?: string
    postalcode?: string
    addendum?: { pad?: { bin?: string; bbl?: string } }
  }
}

/** NYC Planning GeoSearch autocomplete (keyless, official). */
export async function autocompleteAddress(text: string, signal?: AbortSignal): Promise<GeoHit[]> {
  const url = `${GEOSEARCH}?text=${encodeURIComponent(text)}&size=6`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`geosearch ${res.status}`)
  const body = (await res.json()) as { features?: GeoSearchFeature[] }
  return (body.features ?? [])
    .filter((f) => f.geometry?.type === 'Point')
    .map((f) => ({
      label: f.properties.label ?? f.properties.name ?? 'Unknown address',
      name: f.properties.name ?? '',
      borough: f.properties.borough,
      neighbourhood: f.properties.neighbourhood,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      bin: f.properties.addendum?.pad?.bin,
      bbl: f.properties.addendum?.pad?.bbl,
    }))
}
