import type * as maplibregl from 'maplibre-gl'
import type { Feature, FeatureCollection } from 'geojson'
import { fetchFacilities, fetchRoadSegments, fetchStreetLabels, fetchTaxLots, fetchTunnels } from '../api/nyc'
import { sodaInit } from '../lib/soda'

// ---------------------------------------------------------------------------
// The OVERLAYS menu on the 2D tactical map — same datasets, same toggles as
// the legacy 3D layers, drawn ABOVE both basemaps (OSM and the NYS ortho)
// and BELOW the tactical picture. Static sets (boundaries, tunnels, POIs)
// fetch once per session on first enable; viewport sets (address grid,
// roads) refetch around the camera on move, zoom-gated so a citywide view
// never asks Socrata for every lot in Brooklyn.
// ---------------------------------------------------------------------------

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }

let lastStreetsKey = ''

// Same datasets the 3D boundaries layer draws (cesium/boundaries.ts).
const BATTALIONS_URL = 'https://data.cityofnewyork.us/resource/xzng-ft6f.json?$limit=60'
const DIVISIONS_URL = 'https://data.cityofnewyork.us/resource/68m2-uzcb.json?$limit=20'

// Facility predicates — mirror cesium/poi.ts (the 3D icons); the 2D layer
// draws dots + labels instead of SVG billboards.
const POI_WHERE: Record<string, { where: string; color: string; tag: string }> = {
  poiFirehouses: { where: `factype='FIREHOUSE'`, color: '#f87171', tag: 'FH' },
  poiFdny: {
    where: `opabbrev='FDNY' AND factype in('AGENCY EXECUTIVE OFFICE','AGENCY OFFICE','TRAINING FACILITY','PUBLIC SAFETY FACILITY','EMERGENCY MEDICAL STATION','EMERGENCY MEDICL STN','AMBULANCE STATION')`,
    color: '#fb923c',
    tag: 'FD',
  },
  poiPrecincts: { where: `factype='POLICE STATION'`, color: '#93c5fd', tag: 'PD' },
  poiHospitals: { where: `factype in('HOSPITAL','ACUTE CARE HOSPITAL')`, color: '#4ade80', tag: 'H' },
  poiNycem: { where: `opabbrev='NYCEM' AND factype like '%OFFICE%'`, color: '#fdba74', tag: 'EM' },
}

interface BoundaryRow {
  fire_bn?: string
  fire_div?: string
  the_geom?: { type: string; coordinates: number[][][][] }
}

function boundariesFC(rows: BoundaryRow[], label: (r: BoundaryRow) => string): FeatureCollection {
  const features: Feature[] = []
  for (const r of rows) {
    if (!r.the_geom?.coordinates) continue
    features.push({
      type: 'Feature',
      properties: { label: label(r) },
      geometry: { type: 'MultiPolygon', coordinates: r.the_geom.coordinates },
    })
    // Label at the largest ring's centroid.
    let best: number[][] | null = null
    for (const poly of r.the_geom.coordinates) if (!best || poly[0].length > best.length) best = poly[0]
    if (best) {
      let cx = 0
      let cy = 0
      for (const [x, y] of best) {
        cx += x
        cy += y
      }
      features.push({
        type: 'Feature',
        properties: { label: label(r), point: 1 },
        geometry: { type: 'Point', coordinates: [cx / best.length, cy / best.length] },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

/** Ensure a geojson source + its layers exist (idempotent), inserted below
 *  the tactical picture so footprints/units stay on top. */
function ensureLayers(map: maplibregl.Map, id: string, mk: () => maplibregl.LayerSpecification[]): void {
  if (map.getSource(id)) return
  map.addSource(id, { type: 'geojson', data: EMPTY })
  for (const layer of mk()) map.addLayer(layer, 'fp-fill')
}

function setData(map: maplibregl.Map, id: string, fc: FeatureCollection): void {
  ;(map.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(fc)
}

function setVisible(map: maplibregl.Map, ids: string[], on: boolean): void {
  for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
}

const loaded = new Set<string>()
const inflight = new Set<string>()

async function loadOnce(key: string, fn: () => Promise<void>): Promise<void> {
  if (loaded.has(key) || inflight.has(key)) return
  inflight.add(key)
  try {
    await fn()
    loaded.add(key)
  } catch (err) {
    console.warn(`[overlays2d] ${key} unavailable:`, err)
  } finally {
    inflight.delete(key)
  }
}

export type Toggles = Record<string, boolean>

/** Static overlays: boundaries, tunnels, POI sets. Call on every toggle
 *  change; fetches happen once, visibility flips thereafter. */
export function syncStaticOverlays(map: maplibregl.Map, toggles: Toggles): void {
  // FDNY battalions / divisions
  for (const [key, url, color, width] of [
    ['battalions', BATTALIONS_URL, '#f87171', 1.4],
    ['divisions', DIVISIONS_URL, '#f59e0b', 2.4],
  ] as const) {
    ensureLayers(map, `ov-${key}`, () => [
      { id: `ov-${key}-line`, type: 'line', source: `ov-${key}`, filter: ['!', ['has', 'point']], paint: { 'line-color': color, 'line-width': width, 'line-opacity': 0.75 } },
      {
        id: `ov-${key}-label`,
        type: 'symbol',
        source: `ov-${key}`,
        filter: ['has', 'point'],
        layout: { 'text-field': ['get', 'label'], 'text-font': ['Open Sans Regular'], 'text-size': 11 },
        paint: { 'text-color': color, 'text-halo-color': '#0a0e14', 'text-halo-width': 1.4 },
      },
    ])
    if (toggles[key]) {
      void loadOnce(key, async () => {
        const res = await fetch(url, sodaInit())
        if (!res.ok) throw new Error(`${key} SODA ${res.status}`)
        const rows = (await res.json()) as BoundaryRow[]
        setData(map, `ov-${key}`, boundariesFC(rows, (r) => (key === 'battalions' ? `BN ${r.fire_bn ?? ''}` : `DIV ${r.fire_div ?? ''}`)))
      })
    }
    setVisible(map, [`ov-${key}-line`, `ov-${key}-label`], !!toggles[key])
  }

  // Tunnels (small fixed set)
  ensureLayers(map, 'ov-tunnels', () => [
    { id: 'ov-tunnels-line', type: 'line', source: 'ov-tunnels', paint: { 'line-color': '#a78bfa', 'line-width': 3, 'line-dasharray': [2, 1.5], 'line-opacity': 0.85 } },
    {
      id: 'ov-tunnels-label',
      type: 'symbol',
      source: 'ov-tunnels',
      layout: { 'text-field': ['get', 'name'], 'text-font': ['Open Sans Regular'], 'text-size': 10, 'symbol-placement': 'line' },
      paint: { 'text-color': '#c4b5fd', 'text-halo-color': '#0a0e14', 'text-halo-width': 1.4 },
    },
  ])
  if (toggles.tunnels) {
    void loadOnce('tunnels', async () => {
      const segs = await fetchTunnels()
      setData(map, 'ov-tunnels', {
        type: 'FeatureCollection',
        features: segs.map((s) => ({ type: 'Feature', properties: { name: s.name }, geometry: { type: 'MultiLineString', coordinates: s.lines } })),
      })
    })
  }
  setVisible(map, ['ov-tunnels-line', 'ov-tunnels-label'], !!toggles.tunnels)

  // POI sets
  for (const [key, cfg] of Object.entries(POI_WHERE)) {
    ensureLayers(map, `ov-${key}`, () => [
      { id: `ov-${key}-dot`, type: 'circle', source: `ov-${key}`, paint: { 'circle-radius': 5, 'circle-color': cfg.color, 'circle-stroke-color': '#0a0e14', 'circle-stroke-width': 1.5 } },
      {
        id: `ov-${key}-label`,
        type: 'symbol',
        source: `ov-${key}`,
        minzoom: 13,
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Open Sans Regular'], 'text-size': 10, 'text-offset': [0, 1], 'text-anchor': 'top', 'text-optional': true },
        paint: { 'text-color': cfg.color, 'text-halo-color': '#0a0e14', 'text-halo-width': 1.3 },
      },
    ])
    if (toggles[key]) {
      void loadOnce(key, async () => {
        const pts = await fetchFacilities(cfg.where)
        setData(map, `ov-${key}`, {
          type: 'FeatureCollection',
          features: pts.map((p) => ({ type: 'Feature', properties: { name: p.name }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } })),
        })
      })
    }
    setVisible(map, [`ov-${key}-dot`, `ov-${key}-label`], !!toggles[key])
  }
}

// Viewport-scoped overlays — refetch around the camera, zoom-gated.
let lastLotsKey = ''
let lastRoadsKey = ''

export async function syncViewportOverlays(map: maplibregl.Map, toggles: Toggles): Promise<void> {
  // A moveend can land before the style finishes loading (boot flyTo on a
  // cold CARTO fetch) — ensureLayers would throw "Style is not done loading"
  // as an unhandled rejection. Bail BEFORE any ensure/key bookkeeping; the
  // post-load kick in TacticalMap2D re-runs this sync.
  if (!map.isStyleLoaded()) return
  const c = map.getCenter()
  const z = map.getZoom()

  ensureLayers(map, 'ov-lots', () => [
    { id: 'ov-lots-line', type: 'line', source: 'ov-lots', paint: { 'line-color': '#64748b', 'line-width': 0.7, 'line-opacity': 0.65 } },
  ])
  if (toggles.lots && z >= 15) {
    const key = `${c.lat.toFixed(3)},${c.lng.toFixed(3)}`
    if (key !== lastLotsKey) {
      lastLotsKey = key
      try {
        const lots = await fetchTaxLots(c.lat, c.lng, 600)
        setData(map, 'ov-lots', {
          type: 'FeatureCollection',
          features: lots.map((l) => ({ type: 'Feature', properties: { bbl: l.bbl }, geometry: { type: 'MultiPolygon', coordinates: l.polygons } })),
        })
      } catch (err) {
        console.warn('[overlays2d] lots unavailable:', err)
      }
    }
  }
  setVisible(map, ['ov-lots-line'], !!toggles.lots && z >= 15)

  ensureLayers(map, 'ov-roads', () => [
    {
      id: 'ov-roads-line',
      type: 'line',
      source: 'ov-roads',
      paint: {
        'line-color': '#eab308',
        'line-width': ['case', ['==', ['get', 'major'], 1], 2.6, 1.1],
        'line-opacity': ['case', ['==', ['get', 'major'], 1], 0.9, 0.55],
      },
    },
  ])
  if (toggles.roads && z >= 13) {
    const key = `${c.lat.toFixed(2)},${c.lng.toFixed(2)}`
    if (key !== lastRoadsKey) {
      lastRoadsKey = key
      try {
        const segs = await fetchRoadSegments(c.lat, c.lng, 1600)
        setData(map, 'ov-roads', {
          type: 'FeatureCollection',
          features: segs.map((s) => ({
            type: 'Feature',
            properties: { major: s.major ? 1 : 0 },
            geometry: { type: 'MultiLineString', coordinates: s.lines },
          })),
        })
      } catch (err) {
        console.warn('[overlays2d] roads unavailable:', err)
      }
    }
  }
  setVisible(map, ['ov-roads-line'], !!toggles.roads && z >= 13)

  // Street NAMES (CSCL) — basemap furniture, not a toggle: the nolabels
  // bases carry no text at all, so the platform captions its own streets
  // whenever the camera is close enough to work a block.
  ensureLayers(map, 'ov-streetnames', () => [
    {
      id: 'ov-streetnames-label',
      type: 'symbol',
      source: 'ov-streetnames',
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Open Sans Regular'],
        'text-size': 11,
        'text-letter-spacing': 0.08,
        'text-rotate': ['get', 'rot'],
        'text-rotation-alignment': 'map',
        'text-pitch-alignment': 'map',
        'text-padding': 6,
      },
      paint: { 'text-color': '#93a6bd', 'text-halo-color': 'rgba(10, 14, 20, 0.85)', 'text-halo-width': 1.3 },
    },
  ])
  if (z >= 14) {
    const key = `${c.lat.toFixed(3)},${c.lng.toFixed(3)}`
    if (key !== lastStreetsKey) {
      lastStreetsKey = key
      try {
        const labels = await fetchStreetLabels(c.lat, c.lng, 700)
        setData(map, 'ov-streetnames', {
          type: 'FeatureCollection',
          features: labels.map((l) => ({
            type: 'Feature',
            // Upright reading angle: fold the street bearing into [-90, 90).
            properties: { name: l.name, rot: ((l.bearingDeg % 180) + 180) % 180 - 90 },
            geometry: { type: 'Point', coordinates: [l.lon, l.lat] },
          })),
        })
      } catch (err) {
        console.warn('[overlays2d] street names unavailable:', err)
      }
    }
  }
  setVisible(map, ['ov-streetnames-label'], z >= 14)
}
