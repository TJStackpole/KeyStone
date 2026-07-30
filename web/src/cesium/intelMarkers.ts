import * as Cesium from 'cesium'
import type { Firehouse, Hydrant } from '../api/nyc'
import { crispTextImage } from './streets'

// Firehouse glyph: minimal house silhouette, FDNY red, thin light stroke.
const FIREHOUSE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">
  <path d="M13 3 L23 11 L21 11 L21 22 L5 22 L5 11 L3 11 Z"
    fill="#dc2626" stroke="#fca5a5" stroke-width="1.2" stroke-linejoin="round"/>
  <rect x="10.5" y="14" width="5" height="8" fill="#7f1d1d"/>
</svg>`

const FIREHOUSE_ICON = `data:image/svg+xml;base64,${btoa(FIREHOUSE_SVG)}`

const HYDRANT_COLOR = Cesium.Color.fromCssColorString('#22d3ee')
const HYDRANT_OUTLINE = Cesium.Color.fromCssColorString('#0a0e14')

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
        // Clamped to the scene surface — a fixed ellipsoid height floats ~30 m
        // over photorealistic-tile streets (geoid offset).
        position: Cesium.Cartesian3.fromDegrees(h.lon, h.lat, 0),
        point: {
          pixelSize: 7,
          color: HYDRANT_COLOR,
          outlineColor: HYDRANT_OUTLINE,
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
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
        position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, 0),
        billboard: {
          image: FIREHOUSE_ICON,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
      // Crisp 2x canvas text — Cesium's glyph labels blur on retina displays.
      this.firehouseSource.entities.add({
        id: `firehouse:${f.name}:label`,
        position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, 0),
        billboard: {
          image: crispTextImage(f.name, '#eef4fb', 24),
          scale: 0.5,
          pixelOffset: new Cesium.Cartesian2(0, -34),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(600, 1, 6000, 0.6),
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
