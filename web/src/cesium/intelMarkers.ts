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

// Hydrant glyph: bonnet, barrel, side caps, base — small enough to read as a
// street fixture, theme cyan so it can't be mistaken for a unit marker.
const HYDRANT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="18" viewBox="0 0 16 18">
  <path d="M8 1.2 C5.7 1.2 4.1 2.7 3.9 4.6 L12.1 4.6 C11.9 2.7 10.3 1.2 8 1.2 Z" fill="#22d3ee" stroke="#0a0e14" stroke-width="0.8"/>
  <rect x="4.7" y="4.6" width="6.6" height="9" rx="1.2" fill="#22d3ee" stroke="#0a0e14" stroke-width="0.8"/>
  <circle cx="2.9" cy="8.6" r="1.7" fill="#22d3ee" stroke="#0a0e14" stroke-width="0.8"/>
  <circle cx="13.1" cy="8.6" r="1.7" fill="#22d3ee" stroke="#0a0e14" stroke-width="0.8"/>
  <circle cx="8" cy="8.8" r="1.5" fill="#0e7490"/>
  <rect x="3.2" y="13.6" width="9.6" height="2.6" rx="0.9" fill="#22d3ee" stroke="#0a0e14" stroke-width="0.8"/>
</svg>`

const HYDRANT_ICON = `data:image/svg+xml;base64,${btoa(HYDRANT_SVG)}`

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
        // over photorealistic-tile streets (geoid offset). BOTTOM origin so
        // the little hydrant STANDS on the ground instead of sinking into it.
        position: Cesium.Cartesian3.fromDegrees(h.lon, h.lat, 0),
        billboard: {
          image: HYDRANT_ICON,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(300, 1, 4000, 0.45),
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
