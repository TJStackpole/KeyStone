import * as Cesium from 'cesium'
import type { IcsShape, PostKind, ZoneKind } from '../types'

// ---------------------------------------------------------------------------
// ICS overlay rendering: Hot/Warm/Cold zones as translucent polygons with
// glowing borders; command posts as ICS-labeled billboards.
// ---------------------------------------------------------------------------

export const ZONE_STYLE: Record<ZoneKind, { label: string; css: string }> = {
  hot: { label: 'HOT ZONE', css: '#ef4444' },
  warm: { label: 'WARM ZONE', css: '#f59e0b' },
  cold: { label: 'COLD ZONE', css: '#22c55e' },
}

export const POST_META: Record<PostKind, { label: string; glyph: string; css: string }> = {
  icp: { label: 'ICP', glyph: 'ICP', css: '#f59e0b' },
  staging: { label: 'STAGING AREA', glyph: 'STG', css: '#22d3ee' },
  triage: { label: 'TRIAGE', glyph: 'TRI', css: '#ef4444' },
  media: { label: 'MEDIA POINT', glyph: 'MED', css: '#a78bfa' },
  transport: { label: 'EMS TRANSPORT CORRIDOR', glyph: 'TRN', css: '#4ade80' },
}

function postIcon(kind: PostKind): string {
  const m = POST_META[kind]
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="30" viewBox="0 0 34 30">` +
    `<path d="M4 3 h26 v18 h-11 l-4 6 -4 -6 h-7 Z" fill="#0b111c" stroke="${m.css}" stroke-width="1.6"/>` +
    `<text x="17" y="15.5" font-family="Menlo,monospace" font-size="9" font-weight="700" fill="${m.css}" text-anchor="middle">${m.glyph}</text>` +
    `</svg>`
  return `data:image/svg+xml;base64,${btoa(svg)}`
}

const LABEL_FILL = Cesium.Color.fromCssColorString('#dbe4f0')
const LABEL_BG = Cesium.Color.fromCssColorString('#0a0e14').withAlpha(0.78)

export class ShapeLayer {
  private source = new Cesium.CustomDataSource('ics-shapes')

  constructor(viewer: Cesium.Viewer) {
    void viewer.dataSources.add(this.source)
  }

  upsert(shape: IcsShape): void {
    this.remove(shape.id)
    if (shape.kind === 'zone') this.addZone(shape)
    else this.addPost(shape)
  }

  private addZone(shape: Extract<IcsShape, { kind: 'zone' }>): void {
    const color = Cesium.Color.fromCssColorString(ZONE_STYLE[shape.zone].css)
    const flat = shape.positions.flatMap((p) => [p.lon, p.lat])
    const ring = [...flat, flat[0], flat[1]]
    const centroid = shape.positions.reduce(
      (acc, p) => ({ lat: acc.lat + p.lat / shape.positions.length, lon: acc.lon + p.lon / shape.positions.length }),
      { lat: 0, lon: 0 },
    )
    this.source.entities.add({
      id: `shape:${shape.id}`,
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat)),
        material: color.withAlpha(shape.zone === 'hot' ? 0.32 : 0.24),
        classificationType: Cesium.ClassificationType.BOTH,
      },
    })
    this.source.entities.add({
      id: `shape:${shape.id}:border`,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(ring),
        width: 5,
        material: new Cesium.PolylineGlowMaterialProperty({ color, glowPower: 0.28 }),
        clampToGround: true,
      },
    })
    this.source.entities.add({
      id: `shape:${shape.id}:label`,
      position: Cesium.Cartesian3.fromDegrees(centroid.lon, centroid.lat, 2),
      label: {
        text: ZONE_STYLE[shape.zone].label,
        font: `700 12px 'JetBrains Mono', monospace`,
        fillColor: color.brighten(0.35, new Cesium.Color()),
        showBackground: true,
        backgroundColor: LABEL_BG,
        backgroundPadding: new Cesium.Cartesian2(7, 4),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
  }

  private addPost(shape: Extract<IcsShape, { kind: 'post' }>): void {
    this.source.entities.add({
      id: `shape:${shape.id}`,
      position: Cesium.Cartesian3.fromDegrees(shape.lon, shape.lat, 1),
      billboard: {
        image: postIcon(shape.post),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: POST_META[shape.post].label,
        font: `600 10.5px 'JetBrains Mono', monospace`,
        fillColor: LABEL_FILL,
        showBackground: true,
        backgroundColor: LABEL_BG,
        backgroundPadding: new Cesium.Cartesian2(5, 3),
        pixelOffset: new Cesium.Cartesian2(0, -34),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
  }

  remove(id: string): void {
    this.source.entities.removeById(`shape:${id}`)
    this.source.entities.removeById(`shape:${id}:border`)
    this.source.entities.removeById(`shape:${id}:label`)
  }

  clear(): void {
    this.source.entities.removeAll()
  }

  /** Map a picked entity id back to a shape id (for select/edit). */
  static shapeIdFromEntityId(entityId: string): string | null {
    const m = entityId.match(/^shape:(.+?)(?::border|:label)?$/)
    return m ? m[1] : null
  }
}
