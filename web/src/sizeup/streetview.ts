import { GOOGLE_KEY } from './oblique'
import type { FaceView, TargetFrame } from './oblique'

// ---------------------------------------------------------------------------
// Street View for the size-up strip — Static API images (no JS SDK): the
// camera stands off each exposure face looking back at the building, one
// tap per exposure, capture date labeled from the metadata endpoint.
// Keyless: the tab reports plainly that it needs the Google key.
// ---------------------------------------------------------------------------

export interface StreetShot {
  exposure: number
  url: string
  /** e.g. "2024-06" from Street View metadata; null = no coverage there. */
  captureDate: string | null
}

/** Camera position off a face: center pushed out along the face normal far
 *  enough to clear the footprint plus a sidewalk-ish standoff. */
function cameraFor(frame: TargetFrame, face: FaceView): { lat: number; lon: number } {
  const along = angClose(face.headingDeg, frame.bearingA + 90) || angClose(face.headingDeg, frame.bearingA + 270)
  const extent = along ? frame.halfB : frame.halfA
  const d = extent + 28 // meters past the wall — across the street, roughly
  const rad = (face.headingDeg * Math.PI) / 180
  return {
    lat: frame.centerLat + (d * Math.cos(rad)) / 111_320,
    lon: frame.centerLon + (d * Math.sin(rad)) / (111_320 * Math.cos((frame.centerLat * Math.PI) / 180)),
  }
}

function angClose(a: number, b: number): boolean {
  const d = Math.abs(((a - b) % 360) + 360) % 360
  return Math.min(d, 360 - d) < 45
}

export async function streetShot(frame: TargetFrame, face: FaceView, w = 640, h = 400): Promise<StreetShot> {
  if (!GOOGLE_KEY) return { exposure: face.exposure, url: '', captureDate: null }
  const cam = cameraFor(frame, face)
  const heading = (face.headingDeg + 180) % 360 // look back at the building
  const base = `size=${w}x${h}&location=${cam.lat},${cam.lon}&heading=${heading}&fov=85&pitch=8&source=outdoor&key=${GOOGLE_KEY}`
  let captureDate: string | null = null
  try {
    const meta = (await (
      await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?${base}`)
    ).json()) as { status?: string; date?: string }
    if (meta.status !== 'OK') return { exposure: face.exposure, url: '', captureDate: null }
    captureDate = meta.date ?? null
  } catch {
    return { exposure: face.exposure, url: '', captureDate: null }
  }
  return {
    exposure: face.exposure,
    url: `https://maps.googleapis.com/maps/api/streetview?${base}`,
    captureDate,
  }
}
