import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Feature, FeatureCollection } from 'geojson'
import { useEffect, useRef, useState } from 'react'
import type { Footprint } from '../lib/footprints'
import { UNIT_ICON, registerUnitSprites } from './sprites'
import { useAppSlice } from '../state/store'
import type { IcsShape, Unit } from '../types'
import './TacticalMap2D.css'

// ---------------------------------------------------------------------------
// Prompt 14 Phase A — the 2D-first tactical map. Top-down MapLibre view of
// the SAME store the 3D scene renders: real footprint geometry (no
// extrusion), the fire building highlighted, ICS zones/posts/apparatus pads,
// exposure labels, hydrants, and every tracked unit in taxonomy glyphs.
// Keyless: OSM raster base + NYS 2024 orthoimagery one-tap toggle (vintage
// labeled on screen per Phase A.5). No continuous render loop — MapLibre
// only paints on data/camera changes, which is the entire point.
// ---------------------------------------------------------------------------

const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
// NYS Digital Orthoimagery Program, latest statewide mosaic (public, keyless).
// The service is a DYNAMIC MapServer (no tile cache — /tile/{z}/{y}/{x} 404s),
// so we consume it through the ArcGIS export endpoint with MapLibre's
// {bbox-epsg-3857} template.
const NYS_ORTHO_EXPORT =
  'https://orthos.its.ny.gov/arcgis/rest/services/wms/Latest/MapServer/export' +
  '?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=jpg&transparent=false&f=image'
const ORTHO_VINTAGE = 'NYS ORTHO · LATEST (2023-24 CAPTURE)'

const ZONE_COLOR: Record<string, string> = {
  hot: '#ef4444',
  warm: '#f59e0b',
  cold: '#22d3ee',
  perimeter: '#22d3ee',
}

const POST_LABEL: Record<string, string> = {
  icp: 'ICP',
  staging: 'STAGING',
  triage: 'TRIAGE',
  media: 'MEDIA',
  transport: 'TRANSPORT',
  hazard: 'HAZARD',
  water: 'WATER',
  fast: 'FAST',
  exposure: 'EXP',
}

const POST_COLOR: Record<string, string> = {
  icp: '#f59e0b',
  staging: '#22d3ee',
  triage: '#22c55e',
  media: '#94a3b8',
  transport: '#60a5fa',
  hazard: '#ef4444',
  water: '#38bdf8',
  fast: '#f97316',
  exposure: '#fbbf24',
}

type FC = FeatureCollection

const EMPTY: FC = { type: 'FeatureCollection', features: [] }

function footprintFC(feats: Footprint[], targetBin: string | null, which: 'target' | 'neighbors'): FC {
  const out: Feature[] = []
  for (const f of feats) {
    const isTarget = targetBin !== null && f.bin === targetBin
    if ((which === 'target') !== isTarget) continue
    out.push({
      type: 'Feature',
      properties: { bin: f.bin, heightM: Math.round(f.heightM) },
      geometry: { type: 'MultiPolygon', coordinates: f.polygons },
    })
  }
  return { type: 'FeatureCollection', features: out }
}

function unitsFC(units: Record<string, Unit>): FC {
  const features: Feature[] = []
  for (const u of Object.values(units)) {
    // Individual members render small; apparatus get full glyphs + labels.
    const member = u.callsign.includes('/')
    features.push({
      type: 'Feature',
      properties: {
        icon: member ? 'u-member' : (UNIT_ICON[u.category] ?? 'u-other'),
        label: member ? '' : u.callsign,
        member: member ? 1 : 0,
      },
      geometry: { type: 'Point', coordinates: [u.lon, u.lat] },
    })
  }
  return { type: 'FeatureCollection', features }
}

function zonesFC(shapes: Record<string, IcsShape>): FC {
  const features: Feature[] = []
  for (const s of Object.values(shapes)) {
    if (s.kind !== 'zone' || s.positions.length < 3) continue
    const ring = s.positions.map((p) => [p.lon, p.lat])
    ring.push(ring[0])
    features.push({
      type: 'Feature',
      properties: { color: ZONE_COLOR[s.zone] ?? '#22d3ee', fillable: s.zone === 'perimeter' ? 0 : 1 },
      geometry: { type: 'Polygon', coordinates: [ring] },
    })
  }
  return { type: 'FeatureCollection', features }
}

function postsFC(shapes: Record<string, IcsShape>): FC {
  const features: Feature[] = []
  for (const s of Object.values(shapes)) {
    if (s.kind === 'post') {
      features.push({
        type: 'Feature',
        properties: {
          label: s.label ?? POST_LABEL[s.post] ?? s.post.toUpperCase(),
          color: POST_COLOR[s.post] ?? '#22d3ee',
        },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      })
    } else if (s.kind === 'apparatus') {
      features.push({
        type: 'Feature',
        properties: { label: `⌗ ${s.callsign}`, color: '#f59e0b' },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

function hydrantsFC(hydrants: { id: string; lat: number; lon: number }[]): FC {
  return {
    type: 'FeatureCollection',
    features: hydrants.map((h) => ({
      type: 'Feature',
      properties: { id: h.id },
      geometry: { type: 'Point', coordinates: [h.lon, h.lat] },
    })),
  }
}

export function TacticalMap2D() {
  const { active, incident, units, shapes, hydrants, footprintsGeo } = useAppSlice((s) => ({
    active: s.mapMode === '2d',
    incident: s.incident,
    units: s.units,
    shapes: s.shapes,
    hydrants: s.intel.hydrants,
    footprintsGeo: s.footprintsGeo,
  }))
  const divRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const readyRef = useRef(false)
  const [ortho, setOrtho] = useState(false)
  // Bumped by the map's async 'load' — the data-sync effect only runs on
  // renders, and without this the sources would stay EMPTY until the next
  // unrelated store change.
  const [, setLoadTick] = useState(0)

  // Create the map once, on first activation — never for pure-3D sessions.
  useEffect(() => {
    if (!active || mapRef.current || !divRef.current) return
    const map = new maplibregl.Map({
      container: divRef.current,
      center: incident ? [incident.lon, incident.lat] : [-74.006, 40.7127],
      zoom: incident ? 16.6 : 12,
      bearing: 0,
      pitch: 0,
      attributionControl: { compact: true },
      style: {
        version: 8,
        // Keyless glyph host that actually carries this stack — the demotiles
        // host 404s on MapLibre's default fonts, which silently stalls 'load'.
        // (Phase C self-hosts these ranges for offline.)
        glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
        sources: {
          // NOTE: the ortho source is added LAZILY on first SAT toggle — a
          // raster source declared with a hidden layer never reports loaded,
          // which wedges map.loaded() forever (bisected against 6.1.0).
          osm: { type: 'raster', tiles: [OSM_TILES], tileSize: 256, attribution: '© OpenStreetMap contributors' },
          footprints: { type: 'geojson', data: EMPTY },
          target: { type: 'geojson', data: EMPTY },
          zones: { type: 'geojson', data: EMPTY },
          posts: { type: 'geojson', data: EMPTY },
          hydrants: { type: 'geojson', data: EMPTY },
          units: { type: 'geojson', data: EMPTY },
        },
        layers: [
          { id: 'base-osm', type: 'raster', source: 'osm' },
          { id: 'fp-fill', type: 'fill', source: 'footprints', paint: { 'fill-color': '#334155', 'fill-opacity': 0.32 } },
          { id: 'fp-line', type: 'line', source: 'footprints', paint: { 'line-color': '#64748b', 'line-width': 1 } },
          { id: 'target-fill', type: 'fill', source: 'target', paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.4 } },
          { id: 'target-line', type: 'line', source: 'target', paint: { 'line-color': '#fbbf24', 'line-width': 2.5 } },
          {
            id: 'zone-fill',
            type: 'fill',
            source: 'zones',
            filter: ['==', ['get', 'fillable'], 1],
            paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.14 },
          },
          { id: 'zone-line', type: 'line', source: 'zones', paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-dasharray': [2, 1] } },
          { id: 'hydrant-dot', type: 'circle', source: 'hydrants', paint: { 'circle-radius': 4.5, 'circle-color': '#22d3ee', 'circle-stroke-color': '#0a0e14', 'circle-stroke-width': 1.5 } },
          {
            id: 'post-dot',
            type: 'circle',
            source: 'posts',
            paint: { 'circle-radius': 6, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#0a0e14', 'circle-stroke-width': 1.5 },
          },
          {
            id: 'post-label',
            type: 'symbol',
            source: 'posts',
            layout: {
              'text-field': ['get', 'label'],
              'text-font': ['Open Sans Regular'],
              'text-size': 12,
              'text-offset': [0, 1.1],
              'text-anchor': 'top',
              'text-allow-overlap': true,
            },
            paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0a0e14', 'text-halo-width': 1.4 },
          },
          {
            id: 'unit-icon',
            type: 'symbol',
            source: 'units',
            layout: {
              'icon-image': ['get', 'icon'],
              'icon-size': ['case', ['==', ['get', 'member'], 1], 0.5, 0.8],
              'icon-allow-overlap': true,
              'text-field': ['get', 'label'],
              'text-font': ['Open Sans Regular'],
              'text-size': 11,
              'text-offset': [0, 1.2],
              'text-anchor': 'top',
              'text-optional': true,
            },
            paint: { 'text-color': '#e2ecf7', 'text-halo-color': '#0a0e14', 'text-halo-width': 1.6 },
          },
        ],
      },
    })
    // Dev handle — the acceptance harness (and console probes) reach the
    // map through this; no production behavior depends on it.
    ;(window as unknown as { __map2d?: maplibregl.Map }).__map2d = map
    map.on('error', (e) => console.warn('[map2d]', e.error?.message ?? e))
    map.on('load', () => {
      registerUnitSprites(map)
      readyRef.current = true
      setLoadTick((n) => n + 1) // re-render -> sync effect pushes store data
    })
    mapRef.current = map
    return undefined // map persists across 2D/3D flips — cheap, keeps camera
  }, [active, incident])

  // Data sync: store slices -> GeoJSON sources. MapLibre only repaints when
  // something actually changed; idle cost is zero.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current) return
    const set = (id: string, data: FC) => (map.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(data)
    const feats = footprintsGeo?.feats ?? []
    const targetBin = footprintsGeo?.targetBin ?? null
    set('footprints', footprintFC(feats, targetBin, 'neighbors'))
    set('target', footprintFC(feats, targetBin, 'target'))
    set('zones', zonesFC(shapes))
    set('posts', postsFC(shapes))
    set('hydrants', hydrantsFC(hydrants))
    set('units', unitsFC(units))
  })

  // Fly to a newly stood-up incident.
  const lastIncidentId = useRef<string | null>(null)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !incident) {
      lastIncidentId.current = incident?.id ?? null
      return
    }
    if (incident.id !== lastIncidentId.current) {
      lastIncidentId.current = incident.id
      map.flyTo({ center: [incident.lon, incident.lat], zoom: 16.8, duration: 1200 })
    }
  }, [incident])

  // Basemap toggle — the ortho source/layer are created on FIRST use only.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current) return
    if (ortho && !map.getSource('ortho')) {
      map.addSource('ortho', {
        type: 'raster',
        tiles: [NYS_ORTHO_EXPORT],
        tileSize: 256,
        attribution: 'NYS ITS GIS Program Office',
      })
      map.addLayer({ id: 'base-ortho', type: 'raster', source: 'ortho' }, 'fp-fill')
    }
    if (map.getLayer('base-ortho')) map.setLayoutProperty('base-ortho', 'visibility', ortho ? 'visible' : 'none')
    map.setLayoutProperty('base-osm', 'visibility', ortho ? 'none' : 'visible')
  }, [ortho])

  // The container must STAY MOUNTED across 2D/3D flips — unmounting it would
  // strand the persistent map instance on a dead element (blank on return).
  // Hidden via CSS; resize on re-show because the canvas slept at 0x0.
  useEffect(() => {
    if (active) mapRef.current?.resize()
  }, [active])

  return (
    <div className={`map2d-root${active ? '' : ' map2d-hidden'}`}>
      <div ref={divRef} className="map2d-canvas" />
      <div className="map2d-north" title="North is up — the map never rotates">
        N<span>▲</span>
      </div>
      <button className="map2d-base" onClick={() => setOrtho((v) => !v)} title="Toggle the satellite basemap (NYS orthoimagery, keyless)">
        {ortho ? 'MAP' : 'SAT'}
      </button>
      {ortho && <div className="map2d-vintage">{ORTHO_VINTAGE}</div>}
    </div>
  )
}
