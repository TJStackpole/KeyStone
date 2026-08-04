import type * as maplibregl from 'maplibre-gl'
import { saveShape } from '../actions'
import { notify } from '../components/NoticeChip'
import { getAppState, setAppState } from '../state/store'
import type { IcsShape, PostKind, ZoneKind } from '../types'

// ---------------------------------------------------------------------------
// ICS drawing on the 2D tactical map — the same tools, the same store, the
// same saveShape/undo path as the 3D scene, driven by plain map clicks:
//   posts      one tap places ICP/STAGING/TRIAGE/… at the tap point
//   zones      tap vertices, double-tap or Enter closes (≥3), Esc cancels
//   collapse   one tap → 1.5× building-height circle (Module 4 rule)
// Measure / apparatus staging / ground view stay 3D-only (hidden on 2D).
// ---------------------------------------------------------------------------

const POST_KINDS: ReadonlySet<string> = new Set([
  'icp', 'staging', 'triage', 'media', 'transport', 'hazard', 'water', 'fast', 'exposure',
])
const ZONE_KINDS: ReadonlySet<string> = new Set(['hot', 'warm', 'cold', 'perimeter'])

const shapeId = (tag: string) => `WT-ICS-${tag}-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 36).toString(36).toUpperCase()}`

function circlePositions(lat: number, lon: number, radiusM: number, n = 32): { lat: number; lon: number }[] {
  const out: { lat: number; lon: number }[] = []
  const latR = radiusM / 111_320
  const lonR = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180))
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    out.push({ lat: lat + latR * Math.sin(a), lon: lon + lonR * Math.cos(a) })
  }
  return out
}

/** Wire the draw tools onto a loaded 2D map. Returns a teardown. */
export function attachDraw2D(map: maplibregl.Map): () => void {
  let draft: { zone: ZoneKind; points: [number, number][] } | null = null

  const setDraft = (points: [number, number][]) => {
    const src = map.getSource('draft') as maplibregl.GeoJSONSource | undefined
    src?.setData({
      type: 'FeatureCollection',
      features: points.length
        ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: points } }]
        : [],
    })
  }

  const cancelDraft = () => {
    draft = null
    setDraft([])
  }

  const closeDraft = () => {
    if (!draft || draft.points.length < 3) return
    const zone = draft.zone
    const positions = draft.points.map(([lon, lat]) => ({ lat, lon }))
    cancelDraft()
    setAppState({ drawTool: null })
    void saveShape({ id: shapeId(`ZONE-${zone.toUpperCase()}`), kind: 'zone', zone, positions, createdAt: new Date().toISOString() } as IcsShape)
  }

  const onClick = (e: maplibregl.MapMouseEvent) => {
    const tool = getAppState().drawTool
    if (!tool) return
    const { lat, lng } = e.lngLat

    if (POST_KINDS.has(tool)) {
      setAppState({ drawTool: null })
      void saveShape({
        id: shapeId(`POST-${tool.toUpperCase()}`),
        kind: 'post',
        post: tool as PostKind,
        lat,
        lon: lng,
        createdAt: new Date().toISOString(),
      } as IcsShape)
      return
    }

    if (ZONE_KINDS.has(tool)) {
      if (!draft || draft.zone !== tool) draft = { zone: tool as ZoneKind, points: [] }
      draft.points.push([lng, lat])
      setDraft(draft.points)
      return
    }

    if (tool === 'collapse') {
      // Module 4: collapse zone = 1.5× the fire building's roof height.
      const h = getAppState().targetHeightM ?? 15
      setAppState({ drawTool: null })
      void saveShape({
        id: shapeId('ZONE-COLLAPSE'),
        kind: 'zone',
        zone: 'hot',
        positions: circlePositions(lat, lng, Math.max(10, h * 1.5)),
        createdAt: new Date().toISOString(),
      } as IcsShape)
      return
    }

    // measure / apparatus / ground are 3D-scene tools (hidden on 2D; this is
    // the belt-and-suspenders for a stale drawTool).
    notify('THAT TOOL NEEDS THE 3D VIEW — open ISOLATE for the building views')
    setAppState({ drawTool: null })
  }

  const onDblClick = (e: maplibregl.MapMouseEvent) => {
    if (!draft) return
    e.preventDefault() // no zoom while closing a perimeter
    closeDraft()
  }

  const onKey = (e: KeyboardEvent) => {
    if (!draft) return
    if (e.key === 'Enter') closeDraft()
    if (e.key === 'Escape') {
      cancelDraft()
      setAppState({ drawTool: null })
    }
  }

  map.on('click', onClick)
  map.on('dblclick', onDblClick)
  window.addEventListener('keydown', onKey)
  return () => {
    map.off('click', onClick)
    map.off('dblclick', onDblClick)
    window.removeEventListener('keydown', onKey)
  }
}
