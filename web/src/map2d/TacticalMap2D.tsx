import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Feature, FeatureCollection } from 'geojson'
import { useEffect, useRef, useState } from 'react'
import { registerMap2D } from './controller'
import { attachDraw2D } from './draw2d'
import { syncStaticOverlays, syncViewportOverlays } from './overlays'
import type { Footprint } from '../lib/footprints'
import { UNIT_ICON, registerUnitSprites } from './sprites'
import { useCapability } from '../profiles/manifest'
import { setAppState, useAppSlice } from '../state/store'
import type { IcsShape, Unit } from '../types'
import './TacticalMap2D.css'

// ---------------------------------------------------------------------------
// Prompt 14 Phase A — the 2D-first tactical map. Top-down MapLibre view of
// the SAME store the 3D scene renders: real footprint geometry (no
// extrusion), the fire building highlighted, ICS zones/posts/apparatus pads,
// exposure labels, hydrants, and every tracked unit in taxonomy glyphs.
// Keyless: CARTO dark/light raster bases + NYS orthoimagery one-tap toggle
// (vintage labeled on screen per Phase A.5). No continuous render loop —
// MapLibre only paints on data/camera changes, which is the entire point.
// ---------------------------------------------------------------------------

// Clean dark tactical base (CARTO Dark Matter, keyless w/ attribution) — the
// DEFAULT. The LIGHT option is the same cartography in daylight (CARTO
// Positron) — standard OSM carto was tried here and retired: a consumer map
// of subway entrances, shop icons and transit glyphs, cartoonish on a
// command console.
const CARTO_DARK_TILES = 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'
const CARTO_LIGHT_TILES = 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png'
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
      properties: { shapeId: s.id, color: ZONE_COLOR[s.zone] ?? '#22d3ee', fillable: s.zone === 'perimeter' ? 0 : 1 },
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
          shapeId: s.id,
          label: s.label ?? POST_LABEL[s.post] ?? s.post.toUpperCase(),
          color: POST_COLOR[s.post] ?? '#22d3ee',
        },
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      })
    } else if (s.kind === 'apparatus') {
      features.push({
        type: 'Feature',
        properties: { shapeId: s.id, label: `⌗ ${s.callsign}`, color: '#f59e0b' },
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
  const canMap2d = useCapability('view.map2d')
  const { mode2d, incident, units, shapes, hydrants, footprintsGeo, layerToggles, trafficLinks } = useAppSlice((s) => ({
    mode2d: s.mapMode === '2d',
    layerToggles: s.layerToggles,
    incident: s.incident,
    units: s.units,
    shapes: s.shapes,
    hydrants: s.intel.hydrants,
    footprintsGeo: s.footprintsGeo,
    trafficLinks: s.trafficLinks,
  }))
  // 2D is the tactical view ONLY where the manifest grants it (FDNY) — the
  // NYCEM profile keeps its citywide globe untouched.
  const active = canMap2d && mode2d
  const divRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [ready, setReady] = useState(false)
  const [base, setBase] = useState<'dark' | 'light' | 'sat'>('dark')

  // Create the map once, on first activation — never for pure-3D sessions.
  useEffect(() => {
    if (!active || mapRef.current || !divRef.current) return
    const map = new maplibregl.Map({
      container: divRef.current,
      center: incident ? [incident.lon, incident.lat] : [-74.006, 40.7127],
      zoom: incident ? 16.6 : 12,
      bearing: 0,
      pitch: 0,
      // FLAT AND NORTH-UP, PERIOD. Right-drag rotate/pitch and touch
      // rotate/pitch are all off — a skewed "2D" map reads as a broken 3D
      // view and costs orientation while scrolling building to building.
      // ISOLATE's 3D camera is a separate (Cesium) surface and keeps all
      // of its views; this only pins the tactical map.
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
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
          // ONLY the visible base ships in the initial style: a raster
          // source declared with a hidden layer wedges map.loaded() forever
          // (bisected on 4.7 AND 6.1) — OSM and the NYS ortho both attach
          // lazily on first selection.
          carto: { type: 'raster', tiles: [CARTO_DARK_TILES], tileSize: 512, attribution: '© OpenStreetMap contributors © CARTO' },
          footprints: { type: 'geojson', data: EMPTY },
          target: { type: 'geojson', data: EMPTY },
          zones: { type: 'geojson', data: EMPTY },
          posts: { type: 'geojson', data: EMPTY },
          hydrants: { type: 'geojson', data: EMPTY },
          units: { type: 'geojson', data: EMPTY },
          traffic: { type: 'geojson', data: EMPTY },
          draft: { type: 'geojson', data: EMPTY },
        },
        layers: [
          { id: 'base-carto', type: 'raster', source: 'carto' },
          { id: 'fp-fill', type: 'fill', source: 'footprints', paint: { 'fill-color': '#334155', 'fill-opacity': 0.32 } },
          { id: 'fp-line', type: 'line', source: 'footprints', paint: { 'line-color': '#64748b', 'line-width': 1 } },
          // DOT live speeds — features arrive pre-filtered to moderate/heavy
          // (free-flowing links never reach the source; color/width per class).
          {
            id: 'traffic-line',
            type: 'line',
            source: 'traffic',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': 0.9 },
          },
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
            id: 'draft-line',
            type: 'line',
            source: 'draft',
            paint: { 'line-color': '#22d3ee', 'line-width': 2, 'line-dasharray': [1, 1] },
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
    // dragRotate:false covers right-drag; pinch-rotate and shift+arrow
    // rotate live on separate handlers and need their own switches.
    map.touchZoomRotate.disableRotation()
    ;(map.keyboard as unknown as { disableRotation?: () => void }).disableRotation?.()
    map.on('load', () => {
      registerUnitSprites(map)
      setReady(true) // re-render -> sync effect pushes store data
      setAppState({ map2dReady: true }) // boot veil holds until first paintable state
    })
    registerMap2D(map)
    map.on('moveend', () => {
      void syncViewportOverlays(map, mapTogglesRef.current as unknown as Record<string, boolean>)
    })
    const detachDraw = attachDraw2D(map)
    void detachDraw // map lives for the session; torn down with the page
    mapRef.current = map
    return undefined // map persists across 2D/3D flips — cheap, keeps camera
  }, [active, incident])

  // Data sync: store slices -> GeoJSON sources, pushed ONLY when the slice
  // object identity changed — units tick ~5x/sec and re-serializing six
  // unchanged collections per tick would burn worker+GPU for nothing.
  const pushed = useRef<{ fp?: unknown; shapes?: unknown; hydrants?: unknown; units?: unknown; traffic?: unknown }>({})
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const set = (id: string, data: FC) => (map.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(data)
    if (pushed.current.fp !== footprintsGeo) {
      pushed.current.fp = footprintsGeo
      const feats = footprintsGeo?.feats ?? []
      const targetBin = footprintsGeo?.targetBin ?? null
      set('footprints', footprintFC(feats, targetBin, 'neighbors'))
      set('target', footprintFC(feats, targetBin, 'target'))
    }
    if (pushed.current.shapes !== shapes) {
      pushed.current.shapes = shapes
      set('zones', zonesFC(shapes))
      set('posts', postsFC(shapes))
    }
    if (pushed.current.hydrants !== hydrants) {
      pushed.current.hydrants = hydrants
      set('hydrants', hydrantsFC(hydrants))
    }
    if (pushed.current.units !== units) {
      pushed.current.units = units
      set('units', unitsFC(units))
    }
    if (pushed.current.traffic !== trafficLinks) {
      pushed.current.traffic = trafficLinks
      // Moderate/heavy ONLY — a link moving 20+ mph is not congestion and
      // never reaches the map. Red under 10 mph, amber 10-20.
      set('traffic', {
        type: 'FeatureCollection',
        features: trafficLinks
          .filter((l) => l.speedMph < 20)
          .map((l) => ({
            type: 'Feature' as const,
            geometry: { type: 'LineString' as const, coordinates: l.positions },
            properties: l.speedMph < 10 ? { color: '#ef4444', width: 4.5 } : { color: '#f59e0b', width: 3 },
          })),
      })
    }
    // SITE INTEL chips apply here exactly as on the 3D scene — hydrants,
    // neighbor buildings, and the fire-building highlight are all checkable.
    const t = layerToggles as unknown as Record<string, boolean>
    const vis = (id: string, on: boolean) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
    vis('hydrant-dot', t.hydrants !== false)
    vis('traffic-line', t.traffic === true)
    vis('fp-fill', t.footprints !== false)
    vis('fp-line', t.footprints !== false)
    vis('target-fill', t.targetbox !== false)
    vis('target-line', t.targetbox !== false)
    syncStaticOverlays(map, t)
  })

  // OVERLAYS menu -> 2D layers (kept in the every-render sync below so the
  // first pass after the map's async 'load' can't be missed; all calls are
  // idempotent — fetch-once guards, visibility flips only).
  const mapTogglesRef = useRef(layerToggles)
  mapTogglesRef.current = layerToggles

  // Fly to a newly stood-up incident — keyed on POSITION too, so an address
  // correction (same id, new coords) moves the camera with the footprints.
  const lastIncidentKey = useRef<string | null>(null)
  useEffect(() => {
    const map = mapRef.current
    const key = incident ? `${incident.id}|${incident.lat.toFixed(5)},${incident.lon.toFixed(5)}` : null
    if (!map || !incident) {
      lastIncidentKey.current = key
      return
    }
    if (key !== lastIncidentKey.current) {
      lastIncidentKey.current = key
      map.flyTo({ center: [incident.lon, incident.lat], zoom: 16.8, duration: 1200 })
    }
  }, [incident])

  // Basemap picker: DARK (default) / LIGHT (daylight) / SAT. Non-default
  // sources are still created on FIRST use only (declared-hidden rasters
  // wedge loading).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    // Lazy bases must slot in at the BOTTOM of the stack — directly above
    // base-carto — not before 'fp-fill': overlays synced at load also sit
    // before fp-fill, so anchoring there would drop an opaque raster on top
    // of every battalion line / tunnel / POI already on the map.
    const aboveBase = () => {
      const layers = map.getStyle().layers ?? []
      const i = layers.findIndex((l) => l.id === 'base-carto')
      return layers[i + 1]?.id
    }
    if (base === 'light' && !map.getSource('light')) {
      map.addSource('light', { type: 'raster', tiles: [CARTO_LIGHT_TILES], tileSize: 512, attribution: '© OpenStreetMap contributors © CARTO' })
      map.addLayer({ id: 'base-light', type: 'raster', source: 'light' }, aboveBase())
    }
    if (base === 'sat' && !map.getSource('ortho')) {
      map.addSource('ortho', {
        type: 'raster',
        tiles: [NYS_ORTHO_EXPORT],
        tileSize: 256,
        attribution: 'NYS ITS GIS Program Office',
      })
      map.addLayer({ id: 'base-ortho', type: 'raster', source: 'ortho' }, aboveBase())
    }
    // Self-heal instances that inserted a base too high (pre-fix HMR
    // survivors); base-osm is the retired OSM base a live instance may
    // still carry — keep it out of sight.
    for (const id of ['base-light', 'base-ortho']) {
      const next = aboveBase()
      if (map.getLayer(id) && next && next !== id) map.moveLayer(id, next)
    }
    map.setLayoutProperty('base-carto', 'visibility', base === 'dark' ? 'visible' : 'none')
    if (map.getLayer('base-light')) map.setLayoutProperty('base-light', 'visibility', base === 'light' ? 'visible' : 'none')
    if (map.getLayer('base-osm')) map.setLayoutProperty('base-osm', 'visibility', 'none')
    if (map.getLayer('base-ortho')) map.setLayoutProperty('base-ortho', 'visibility', base === 'sat' ? 'visible' : 'none')
  }, [base, ready])

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
      <button
        className="map2d-base"
        onClick={() => setBase((v) => (v === 'dark' ? 'light' : v === 'light' ? 'sat' : 'dark'))}
        title="Basemap: DARK tactical → LIGHT daylight (same clean cartography) → SAT (NYS orthoimagery). Tap to cycle."
      >
        {base === 'dark' ? 'DARK' : base === 'light' ? 'LIGHT' : 'SAT'}
      </button>
      {base === 'sat' && <div className="map2d-vintage">{ORTHO_VINTAGE}</div>}
    </div>
  )
}
