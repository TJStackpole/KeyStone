import * as Cesium from 'cesium'
import type { Firehouse, Hydrant } from '../api/nyc'

// Firehouse glyph: minimal house silhouette, FDNY red, thin light stroke.
const FIREHOUSE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">
  <path d="M13 3 L23 11 L21 11 L21 22 L5 22 L5 11 L3 11 Z"
    fill="#dc2626" stroke="#fca5a5" stroke-width="1.2" stroke-linejoin="round"/>
  <rect x="10.5" y="14" width="5" height="8" fill="#7f1d1d"/>
</svg>`

const FIREHOUSE_ICON = `data:image/svg+xml;base64,${btoa(FIREHOUSE_SVG)}`

const HYDRANT_COLOR = Cesium.Color.fromCssColorString('#22d3ee')
const HYDRANT_OUTLINE = Cesium.Color.fromCssColorString('#0a0e14')
const LABEL_FILL = Cesium.Color.fromCssColorString('#dbe4f0')
const LABEL_BG = Cesium.Color.fromCssColorString('#0a0e14').withAlpha(0.72)

/**
 * Site-intel globe markers: hydrants (cyan points) and firehouses (red house
 * billboards + name labels), each in its own data source for clean toggling.
 */
export class IntelMarkerLayer {
  private hydrantSource = new Cesium.CustomDataSource('hydrants')
  private firehouseSource = new Cesium.CustomDataSource('firehouses')

  constructor(viewer: Cesium.Viewer) {
    void viewer.dataSources.add(this.hydrantSource)
    void viewer.dataSources.add(this.firehouseSource)
  }

  setHydrants(hydrants: Hydrant[]): void {
    this.hydrantSource.entities.removeAll()
    for (const h of hydrants) {
      this.hydrantSource.entities.add({
        id: `hydrant:${h.id}`,
        position: Cesium.Cartesian3.fromDegrees(h.lon, h.lat, 1),
        point: {
          pixelSize: 7,
          color: HYDRANT_COLOR,
          outlineColor: HYDRANT_OUTLINE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
    }
  }

  setFirehouses(firehouses: Firehouse[]): void {
    this.firehouseSource.entities.removeAll()
    for (const f of firehouses) {
      this.firehouseSource.entities.add({
        id: `firehouse:${f.name}`,
        position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, 1),
        billboard: {
          image: FIREHOUSE_ICON,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: f.name,
          font: `600 11px 'JetBrains Mono', monospace`,
          fillColor: LABEL_FILL,
          showBackground: true,
          backgroundColor: LABEL_BG,
          backgroundPadding: new Cesium.Cartesian2(6, 3),
          pixelOffset: new Cesium.Cartesian2(0, -30),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
    }
  }

  setHydrantsVisible(show: boolean): void {
    this.hydrantSource.show = show
  }

  setFirehousesVisible(show: boolean): void {
    this.firehouseSource.show = show
  }

  clear(): void {
    this.hydrantSource.entities.removeAll()
    this.firehouseSource.entities.removeAll()
  }
}
