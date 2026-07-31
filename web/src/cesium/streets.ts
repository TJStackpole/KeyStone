import * as Cesium from 'cesium'
import type { StreetLabel } from '../api/nyc'

/**
 * Street-name captions (NYC Street Centerline data) — painted ONTO the
 * street surface as ground-draped text quads, like the printed names on a
 * paper map. World-fixed: they foreshorten with the ground in 3D, never
 * re-aim with the camera, and never jump. Refreshes DIFF against what's
 * already drawn, so panning only adds/removes labels at the edges instead
 * of flickering the whole set.
 */

const TEXT_FILL = '#cbdaea'
const TEXT_HALO = 'rgba(6, 10, 16, 0.92)'

const imageCache = new Map<string, HTMLCanvasElement>()

/**
 * Crisp text-as-image for billboards: drawn at 2x and rendered at scale 0.5,
 * so it stays sharp on retina displays where Cesium's glyph labels go soft.
 * Shared by street captions and firehouse/marker labels.
 */
export function crispTextImage(text: string, fill = TEXT_FILL, sizePx = 22): HTMLCanvasElement {
  const key = `${fill}|${sizePx}|${text}`
  const cached = imageCache.get(key)
  if (cached) return cached
  const font = `600 ${sizePx}px 'JetBrains Mono', monospace` // 2x, downscaled for crispness
  const canvas = document.createElement('canvas')
  const measure = canvas.getContext('2d')!
  measure.font = font
  canvas.width = Math.ceil(measure.measureText(text).width) + 18
  canvas.height = Math.ceil(sizePx * 1.5)
  const ctx = canvas.getContext('2d')!
  ctx.font = font
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 6
  ctx.strokeStyle = TEXT_HALO
  ctx.strokeText(text, 9, canvas.height / 2 + 1)
  ctx.fillStyle = fill
  ctx.fillText(text, 9, canvas.height / 2 + 1)
  imageCache.set(key, canvas)
  return canvas
}

/** Rotation (radians CCW from the east-west axis) for a street bearing, kept
 *  in (-90, 90] so painted text never reads upside down. */
function rotationFor(bearingDeg: number): number {
  let theta = 90 - bearingDeg
  while (theta > 90) theta -= 180
  while (theta <= -90) theta += 180
  return Cesium.Math.toRadians(theta)
}

// High-res paint texture: rendered ~64 px tall, draped at ~7 m text height.
const PAINT_FONT_PX = 64
const PAINT_CANVAS_H = 96
const TEXT_HEIGHT_M = 7
const MAX_LABELS = 60

const paintCache = new Map<string, HTMLCanvasElement>()

function streetPaintCanvas(name: string): HTMLCanvasElement {
  const text = name.toUpperCase()
  const cached = paintCache.get(text)
  if (cached) return cached
  const font = `600 ${PAINT_FONT_PX}px 'Inter', -apple-system, sans-serif`
  const canvas = document.createElement('canvas')
  const measure = canvas.getContext('2d')!
  measure.font = font
  canvas.width = Math.ceil(measure.measureText(text).width) + 40
  canvas.height = PAINT_CANVAS_H
  const ctx = canvas.getContext('2d')!
  ctx.font = font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 11
  ctx.strokeStyle = TEXT_HALO
  ctx.strokeText(text, canvas.width / 2, PAINT_CANVAS_H / 2 + 2)
  ctx.fillStyle = TEXT_FILL
  ctx.fillText(text, canvas.width / 2, PAINT_CANVAS_H / 2 + 2)
  paintCache.set(text, canvas)
  return canvas
}

/** One street name draped on the ground, oriented along the street. */
function buildPaintPrimitive(s: StreetLabel): Cesium.GroundPrimitive {
  const canvas = streetPaintCanvas(s.name)
  // World size from the canvas aspect at a fixed text height.
  const heightM = TEXT_HEIGHT_M * (PAINT_CANVAS_H / PAINT_FONT_PX)
  const lengthM = Math.min(200, heightM * (canvas.width / canvas.height))
  const latM = 111_320
  const lonM = 111_320 * Math.cos((s.lat * Math.PI) / 180)
  const rect = Cesium.Rectangle.fromDegrees(
    s.lon - lengthM / 2 / lonM,
    s.lat - heightM / 2 / latM,
    s.lon + lengthM / 2 / lonM,
    s.lat + heightM / 2 / latM,
  )
  const rotation = rotationFor(s.bearingDeg)
  return new Cesium.GroundPrimitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: new Cesium.RectangleGeometry({
        rectangle: rect,
        rotation,
        // Texture rotates WITH the quad — text runs along the street.
        stRotation: rotation,
        vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
      }),
    }),
    appearance: new Cesium.MaterialAppearance({
      material: Cesium.Material.fromType('Image', { image: canvas }),
      materialSupport: Cesium.MaterialAppearance.MaterialSupport.TEXTURED,
      translucent: true, // canvas alpha — only the glyphs paint
    }),
    // Drape onto whichever surface is under the camera: photorealistic
    // tiles in google mode, the globe in keyless.
    classificationType: Cesium.ClassificationType.BOTH,
    asynchronous: true,
  })
}

export class StreetLabelLayer {
  private viewer: Cesium.Viewer
  private byKey = new Map<string, Cesium.GroundPrimitive>()
  private visible = true

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer
  }

  /**
   * Diff-based update: labels already on the ground stay put (no flicker,
   * no re-baking); only genuinely new names are built and stale ones removed.
   */
  set(labels: StreetLabel[]): void {
    const next = new Set<string>()
    for (const s of labels.slice(0, MAX_LABELS)) {
      const key = `${s.name}@${s.lat.toFixed(4)},${s.lon.toFixed(4)}`
      next.add(key)
      if (this.byKey.has(key)) continue
      const prim = buildPaintPrimitive(s)
      prim.show = this.visible
      this.byKey.set(key, prim)
      this.viewer.scene.groundPrimitives.add(prim)
    }
    for (const [key, prim] of this.byKey) {
      if (!next.has(key)) {
        this.viewer.scene.groundPrimitives.remove(prim) // remove() destroys
        this.byKey.delete(key)
      }
    }
  }

  setVisible(show: boolean): void {
    this.visible = show
    for (const prim of this.byKey.values()) prim.show = show
  }

  clear(): void {
    for (const prim of this.byKey.values()) this.viewer.scene.groundPrimitives.remove(prim)
    this.byKey.clear()
  }
}
