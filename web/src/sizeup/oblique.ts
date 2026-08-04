import { getAppState } from '../state/store'

// ---------------------------------------------------------------------------
// Prompt 14 A2 — oblique size-up imagery, one swappable provider interface:
//   nys-ortho   keyless default: latest NYS orthoimagery, cropped to the
//               building and ROTATED so the viewed exposure faces the
//               operator, exposure + vintage burned onto every frame.
//   google45    keyed upgrade (GOOGLE_MAPS_API_KEY): true 45° aerial via the
//               Maps JS API, loaded ONLY when this provider is selected.
//   eagleview   licensed upgrade (Pictometry) — documented stub; the drop-in
//               is implementing getFace() against their oblique API.
// ---------------------------------------------------------------------------

export interface FaceView {
  /** 1..4 per FDNY convention (1 = street side when the EXPO tool has run). */
  exposure: number
  /** Outward normal bearing of this face, degrees true. */
  headingDeg: number
}

export interface TargetFrame {
  centerLat: number
  centerLon: number
  bearingA: number
  halfA: number
  halfB: number
}

/** The four faces, exposure-numbered. When EXPO posts exist their real
 *  street-side assignment wins; otherwise EXP 1 falls back to the most
 *  south-facing face (press EXPO on the rail to set the true street side). */
export function faceViews(frame: TargetFrame): FaceView[] {
  const normals = [0, 90, 180, 270].map((d) => (frame.bearingA + 90 + d) % 360)
  const posts = Object.values(getAppState().shapes).filter(
    (s): s is Extract<typeof s, { kind: 'post' }> => s.kind === 'post' && s.post === 'exposure' && !!s.label,
  )
  if (posts.length === 4) {
    // Bearing from building center to each EXP post = that face's normal.
    const out: FaceView[] = []
    for (const p of posts) {
      const n = Number(/(\d)/.exec(p.label ?? '')?.[1])
      if (!n) continue
      const dLon = (p.lon - frame.centerLon) * Math.cos((frame.centerLat * Math.PI) / 180)
      const dLat = p.lat - frame.centerLat
      const bearing = ((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360
      // snap to the nearest rectangle normal so the crop is face-square
      const snapped = normals.reduce((a, b) => (angDiff(b, bearing) < angDiff(a, bearing) ? b : a))
      out.push({ exposure: n, headingDeg: snapped })
    }
    if (out.length === 4) return out.sort((a, b) => a.exposure - b.exposure)
  }
  // Fallback: EXP 1 = most south-facing normal, 2-3-4 clockwise from it.
  const start = normals.reduce((a, b) => (angDiff(b, 180) < angDiff(a, 180) ? b : a))
  const idx = normals.indexOf(start)
  return [0, 1, 2, 3].map((i) => ({ exposure: i + 1, headingDeg: normals[(idx + i) % 4] }))
}

function angDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

const merc = (lat: number, lon: number) => {
  const x = (lon * 20037508.34) / 180
  const y = ((Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180)) * 20037508.34) / 180
  return { x, y }
}

export const NYS_VINTAGE = 'NYS ORTHO · LATEST (2023-24)'

/** Keyless oblique: fetch the NYS export for a square around the building,
 *  rotate so the viewed face is toward the operator, burn labels. Returns a
 *  data URL sized for the strip. */
export async function nysOrthoFace(frame: TargetFrame, face: FaceView, w = 640, h = 400): Promise<string> {
  const { x, y } = merc(frame.centerLat, frame.centerLon)
  const half = Math.max(frame.halfA, frame.halfB) * 2.4 + 50
  const url =
    'https://orthos.its.ny.gov/arcgis/rest/services/wms/Latest/MapServer/export' +
    `?bbox=${x - half},${y - half},${x + half},${y + half}` +
    '&bboxSR=3857&imageSR=3857&size=1000,1000&format=jpg&transparent=false&f=image'
  const img = await loadImage(url)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.save()
  ctx.translate(w / 2, h / 2)
  // Rotate the north-up image so this face's OUTWARD normal points down —
  // i.e. the operator stands off that side looking at the building.
  ctx.rotate(((180 - face.headingDeg) * Math.PI) / 180)
  const scale = Math.max(w, h) / 700 // over-scan so corners never show void
  ctx.drawImage(img, (-1000 / 2) * scale, (-1000 / 2) * scale, 1000 * scale, 1000 * scale)
  ctx.restore()
  burnLabel(ctx, w, h, `EXPOSURE ${face.exposure}`, `${NYS_VINTAGE} · ROTATED ORTHO`)
  return c.toDataURL('image/jpeg', 0.85)
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('imagery fetch failed'))
    img.src = url
  })
}

export function burnLabel(ctx: CanvasRenderingContext2D, w: number, h: number, main: string, sub: string): void {
  ctx.save()
  ctx.fillStyle = 'rgba(10, 14, 20, 0.78)'
  ctx.fillRect(0, h - 46, w, 46)
  ctx.fillStyle = '#f59e0b'
  ctx.font = "700 20px 'JetBrains Mono', monospace"
  ctx.fillText(main, 12, h - 22)
  ctx.fillStyle = '#94a3b8'
  ctx.font = "600 11px 'JetBrains Mono', monospace"
  ctx.fillText(sub, 12, h - 7)
  ctx.restore()
}

// --- Google 45° (keyed) ----------------------------------------------------

export const GOOGLE_KEY = (import.meta.env.GOOGLE_MAPS_API_KEY as string | undefined) ?? ''

let mapsJsLoading: Promise<void> | null = null

/** Load the Maps JS API once, on first use only — never in the base bundle. */
export function loadMapsJs(): Promise<void> {
  if (!GOOGLE_KEY) return Promise.reject(new Error('no key'))
  if ((window as { google?: { maps?: unknown } }).google?.maps) return Promise.resolve()
  if (!mapsJsLoading) {
    mapsJsLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_KEY}&v=weekly&loading=async&callback=__ksMapsReady`
      ;(window as unknown as Record<string, unknown>).__ksMapsReady = () => resolve()
      s.onerror = () => reject(new Error('Maps JS failed to load'))
      document.head.appendChild(s)
    })
  }
  return mapsJsLoading
}

// --- EagleView / Pictometry (licensed) — drop-in stub -----------------------
// Implementing this provider = one function: fetch their oblique frame for
// (centerLat, centerLon, cardinal(face.headingDeg)) with the license key,
// then burnLabel(exposure, their capture date). Everything else is wired.
export const EAGLEVIEW_AVAILABLE = false
