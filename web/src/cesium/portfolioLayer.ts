import * as Cesium from 'cesium'
import { setAppState } from '../state/store'
import type { NwsAlert, PortfolioIncident } from '../types'
import { crispTextImage } from './streets'

// ---------------------------------------------------------------------------
// Prompt 11 Module 1 — Watch Command portfolio markers: every active incident
// citywide as one marker, sized/colored by severity, with hover driving the
// portfolio hover card and click driving the tactical click-through. Also
// draws the weather strip: active NWS watch/warning polygons (NWS provides
// the geometry) while Watch Command is up.
// ---------------------------------------------------------------------------

const SEVERITY_COLOR: Record<number, string> = {
  1: '#38bdf8',
  2: '#fbbf24',
  3: '#fb923c',
  4: '#f87171',
  5: '#ef4444',
}

function markerIcon(severity: number, focused: boolean): string {
  const c = SEVERITY_COLOR[Math.min(5, Math.max(1, severity))] ?? '#fbbf24'
  const r = 7 + severity * 2
  const size = r * 2 + 8
  const ring = focused ? `<circle cx="${size / 2}" cy="${size / 2}" r="${r + 3}" fill="none" stroke="#22d3ee" stroke-width="2"/>` : ''
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `${ring}<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="${c}" fill-opacity="0.85" stroke="#0a0e14" stroke-width="2"/>` +
    `</svg>`
  return `data:image/svg+xml;base64,${btoa(svg)}`
}

export class PortfolioLayer {
  private source = new Cesium.CustomDataSource('watch-portfolio')
  private weatherSource = new Cesium.CustomDataSource('watch-weather')
  private handler: Cesium.ScreenSpaceEventHandler | null = null
  private onPick: ((id: string) => void) | null = null

  constructor(private viewer: Cesium.Viewer) {
    void viewer.dataSources.add(this.source)
    void viewer.dataSources.add(this.weatherSource)
    this.source.show = false
    this.weatherSource.show = false
  }

  setIncidents(incidents: PortfolioIncident[]): void {
    this.source.entities.removeAll()
    for (const pi of incidents) {
      this.source.entities.add({
        id: `pf:${pi.id}`,
        position: Cesium.Cartesian3.fromDegrees(pi.lon, pi.lat, 0),
        billboard: {
          image: markerIcon(pi.severity, pi.focused),
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          // No silent simulation: feed boxes and drill secondaries carry the
          // SIM tag right on the marker, not only in the hover card.
          text: `${pi.primaryAgency} · ${pi.type}${pi.source !== 'board' ? ' · SIM' : ''}`,
          font: `600 10px 'JetBrains Mono', monospace`,
          fillColor: Cesium.Color.fromCssColorString('#dbe4f0'),
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#0a0e14').withAlpha(0.78),
          backgroundPadding: new Cesium.Cartesian2(5, 3),
          pixelOffset: new Cesium.Cartesian2(0, -26),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 120_000),
        },
      })
    }
  }

  /** NWS watch/warning polygons — shaded, labeled, SIMULATED-tagged when so. */
  setWeather(alerts: NwsAlert[]): void {
    this.weatherSource.entities.removeAll()
    for (const a of alerts) {
      for (let i = 0; i < a.polygons.length; i++) {
        const ring = a.polygons[i]
        if (!ring || ring.length < 3) continue
        this.weatherSource.entities.add({
          id: `wx:${a.id}:${i}`,
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(ring.flat())),
            material: Cesium.Color.fromCssColorString(a.severity === 'Severe' ? '#ef4444' : '#f59e0b').withAlpha(0.16),
            outline: false,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
        })
        const cLon = ring.reduce((s, p) => s + p[0], 0) / ring.length
        const cLat = ring.reduce((s, p) => s + p[1], 0) / ring.length
        this.weatherSource.entities.add({
          id: `wx:${a.id}:${i}:label`,
          position: Cesium.Cartesian3.fromDegrees(cLon, cLat, 0),
          billboard: {
            image: crispTextImage(`${a.event.toUpperCase()}${a.simulated ? ' (SIMULATED)' : ''}`, '#fca5a5', 20),
            scale: 0.55,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        })
      }
    }
  }

  /** Enter/exit Watch Command: markers + weather + hover/click picking. */
  setActive(on: boolean, onPick?: (id: string) => void): void {
    this.source.show = on
    this.weatherSource.show = on
    this.onPick = onPick ?? null
    if (on && !this.handler) {
      const h = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas)
      h.setInputAction((m: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
        const picked = this.viewer.scene.pick(m.endPosition) as { id?: { id?: string } } | undefined
        const id = typeof picked?.id?.id === 'string' && picked.id.id.startsWith('pf:') ? picked.id.id.slice(3) : null
        setAppState((s) => (s.portfolioHoverId === id ? {} : { portfolioHoverId: id }))
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
      h.setInputAction((c: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
        const picked = this.viewer.scene.pick(c.position) as { id?: { id?: string } } | undefined
        const id = typeof picked?.id?.id === 'string' && picked.id.id.startsWith('pf:') ? picked.id.id.slice(3) : null
        if (id) this.onPick?.(id)
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
      this.handler = h
    } else if (!on && this.handler) {
      this.handler.destroy()
      this.handler = null
      setAppState({ portfolioHoverId: null })
    }
  }
}
