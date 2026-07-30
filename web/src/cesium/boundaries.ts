import * as Cesium from 'cesium'
import { maybeFailNyc } from '../lib/failNyc'

// FDNY administrative boundaries (NYC Open Data) — toggleable overlay.
const BATTALIONS = 'https://data.cityofnewyork.us/resource/xzng-ft6f.json?$limit=60'
const DIVISIONS = 'https://data.cityofnewyork.us/resource/68m2-uzcb.json?$limit=20'

export type BoundaryKind = 'battalions' | 'divisions'

interface BoundaryRow {
  fire_bn?: string
  fire_div?: string
  the_geom?: { type: string; coordinates: number[][][][] }
}

const STYLE: Record<BoundaryKind, { url: string; color: string; width: number; label: (r: BoundaryRow) => string }> = {
  battalions: {
    url: BATTALIONS,
    color: '#22d3ee',
    width: 2,
    label: (r) => `BN ${r.fire_bn ?? '?'}`,
  },
  divisions: {
    url: DIVISIONS,
    color: '#f59e0b',
    width: 3,
    label: (r) => `DIV ${r.fire_div ?? '?'}`,
  },
}

/** Largest outer ring's centroid — good enough for a label anchor. */
function labelAnchor(coords: number[][][][]): { lat: number; lon: number } | null {
  let best: number[][] | null = null
  for (const poly of coords) {
    const outer = poly[0]
    if (outer && (!best || outer.length > best.length)) best = outer
  }
  if (!best) return null
  let lat = 0
  let lon = 0
  for (const [x, y] of best) {
    lon += x
    lat += y
  }
  return { lat: lat / best.length, lon: lon / best.length }
}

/**
 * Battalion / division boundary overlays. Fetched lazily on first toggle,
 * cached in their own data sources afterward.
 */
export class BoundaryLayer {
  private sources: Partial<Record<BoundaryKind, Cesium.CustomDataSource>> = {}
  private loading: Partial<Record<BoundaryKind, Promise<void>>> = {}

  constructor(private viewer: Cesium.Viewer) {}

  async setVisible(kind: BoundaryKind, show: boolean): Promise<void> {
    if (!show) {
      const src = this.sources[kind]
      if (src) src.show = false
      return
    }
    if (!this.sources[kind]) {
      // Don't cache a REJECTED load forever — one transient SODA failure
      // would permanently disable the layer for the session.
      this.loading[kind] ??= this.load(kind).catch((err) => {
        this.loading[kind] = undefined
        throw err
      })
      await this.loading[kind]
    }
    const src = this.sources[kind]
    if (src) src.show = true
  }

  private async load(kind: BoundaryKind): Promise<void> {
    maybeFailNyc()
    const style = STYLE[kind]
    const res = await fetch(style.url)
    if (!res.ok) throw new Error(`${kind} SODA ${res.status}`)
    const rows = (await res.json()) as BoundaryRow[]

    const source = new Cesium.CustomDataSource(`fdny-${kind}`)
    const color = Cesium.Color.fromCssColorString(style.color)
    for (const row of rows) {
      if (row.the_geom?.type !== 'MultiPolygon') continue
      for (let i = 0; i < row.the_geom.coordinates.length; i++) {
        const outer = row.the_geom.coordinates[i][0]
        if (!outer || outer.length < 4) continue
        source.entities.add({
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(outer.flat()),
            width: style.width,
            material: color.withAlpha(kind === 'battalions' ? 0.55 : 0.75),
            clampToGround: true,
          },
        })
      }
      const anchor = labelAnchor(row.the_geom.coordinates)
      if (anchor) {
        source.entities.add({
          position: Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat, 2),
          label: {
            text: style.label(row),
            font: `700 ${kind === 'battalions' ? 11 : 14}px 'JetBrains Mono', monospace`,
            fillColor: color.brighten(0.3, new Cesium.Color()),
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString('#0a0e14').withAlpha(0.6),
            backgroundPadding: new Cesium.Cartesian2(5, 3),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(3000, 1.1, 60000, 0.55),
          },
        })
      }
    }
    await this.viewer.dataSources.add(source)
    this.sources[kind] = source
  }
}
