import * as Cesium from 'cesium'
import type { Unit, UnitCategory } from '../types'

// ---------------------------------------------------------------------------
// Unit taxonomy billboards (CLAUDE.md): FDNY Engine red square · Ladder red
// diamond · Battalion white-on-red star · Rescue/Squad dark red · EMS blue
// cross · NYPD navy circle · ESU navy diamond · OEM orange pentagon · Drone
// cyan rotor. Labels are callsigns. MIL-STD-2525-adjacent friendly framing.
// ---------------------------------------------------------------------------

const S = 26 // icon canvas size

function svgIcon(inner: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${inner}</svg>`
  return `data:image/svg+xml;base64,${btoa(svg)}`
}

const STROKE = 'stroke="#e2e8f0" stroke-width="1.4"'

const ICONS: Record<UnitCategory, string> = {
  engine: svgIcon(`<rect x="4" y="4" width="18" height="18" rx="2" fill="#dc2626" ${STROKE}/>`),
  ladder: svgIcon(`<path d="M13 2 L24 13 L13 24 L2 13 Z" fill="#dc2626" ${STROKE}/>`),
  battalion: svgIcon(
    `<rect x="3" y="3" width="20" height="20" rx="2" fill="#dc2626" ${STROKE}/>` +
      `<path d="M13 6.5 L14.9 10.9 L19.7 11.3 L16.1 14.4 L17.2 19.1 L13 16.6 L8.8 19.1 L9.9 14.4 L6.3 11.3 L11.1 10.9 Z" fill="#ffffff"/>`,
  ),
  rescue: svgIcon(`<rect x="4" y="4" width="18" height="18" rx="2" fill="#7f1d1d" ${STROKE}/>`),
  ems: svgIcon(
    `<rect x="4" y="4" width="18" height="18" rx="2" fill="#1d4ed8" ${STROKE}/>` +
      `<path d="M11 7 h4 v4 h4 v4 h-4 v4 h-4 v-4 h-4 v-4 h4 Z" fill="#ffffff"/>`,
  ),
  nypd: svgIcon(`<circle cx="13" cy="13" r="10" fill="#1e3a8a" ${STROKE}/>`),
  esu: svgIcon(`<path d="M13 2 L24 13 L13 24 L2 13 Z" fill="#1e3a8a" ${STROKE}/>`),
  oem: svgIcon(`<path d="M13 2.5 L23.5 10.2 L19.5 22.5 L6.5 22.5 L2.5 10.2 Z" fill="#ea580c" ${STROKE}/>`),
  drone: svgIcon(
    `<circle cx="7" cy="7" r="4.4" fill="none" stroke="#22d3ee" stroke-width="1.6"/>` +
      `<circle cx="19" cy="7" r="4.4" fill="none" stroke="#22d3ee" stroke-width="1.6"/>` +
      `<circle cx="7" cy="19" r="4.4" fill="none" stroke="#22d3ee" stroke-width="1.6"/>` +
      `<circle cx="19" cy="19" r="4.4" fill="none" stroke="#22d3ee" stroke-width="1.6"/>` +
      `<rect x="10.5" y="10.5" width="5" height="5" rx="1" fill="#22d3ee"/>`,
  ),
  unknown: svgIcon(`<circle cx="13" cy="13" r="9" fill="#475569" ${STROKE}/><circle cx="13" cy="13" r="3" fill="#e2e8f0"/>`),
}

const LABEL_FILL = Cesium.Color.fromCssColorString('#dbe4f0')
const LABEL_BG = Cesium.Color.fromCssColorString('#0a0e14').withAlpha(0.75)

/**
 * Renders the live unit picture as Cesium billboards with callsign labels.
 * Positions are SampledPositionProperties so movement between 2 s CoT updates
 * interpolates smoothly instead of teleporting.
 */
export class UnitLayer {
  private source = new Cesium.CustomDataSource('units')

  constructor(viewer: Cesium.Viewer) {
    void viewer.dataSources.add(this.source)
  }

  upsert(unit: Unit): void {
    const id = `unit:${unit.uid}`
    const position = Cesium.Cartesian3.fromDegrees(unit.lon, unit.lat, unit.hae)
    const now = Cesium.JulianDate.now()

    let entity = this.source.entities.getById(id)
    if (!entity) {
      const sampled = new Cesium.SampledPositionProperty()
      sampled.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD
      sampled.backwardExtrapolationType = Cesium.ExtrapolationType.HOLD
      sampled.setInterpolationOptions({
        interpolationDegree: 1,
        // Typings model this as an instance; the runtime API takes the static class.
        interpolationAlgorithm: Cesium.LinearApproximation as unknown as Cesium.InterpolationAlgorithm,
      })
      sampled.addSample(now, position)
      entity = this.source.entities.add({
        id,
        position: sampled,
        billboard: {
          image: ICONS[unit.category] ?? ICONS.unknown,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: unit.callsign,
          font: `600 11px 'JetBrains Mono', monospace`,
          fillColor: LABEL_FILL,
          showBackground: true,
          backgroundColor: LABEL_BG,
          backgroundPadding: new Cesium.Cartesian2(5, 3),
          pixelOffset: new Cesium.Cartesian2(0, -24),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
    } else {
      ;(entity.position as Cesium.SampledPositionProperty).addSample(now, position)
      if (entity.label && entity.label.text?.getValue(now) !== unit.callsign) {
        entity.label.text = new Cesium.ConstantProperty(unit.callsign)
      }
      if (entity.billboard) {
        entity.billboard.image = new Cesium.ConstantProperty(ICONS[unit.category] ?? ICONS.unknown)
      }
    }
  }

  remove(uid: string): void {
    this.source.entities.removeById(`unit:${uid}`)
  }

  /** Latest known position, for click-to-fly. */
  positionOf(uid: string): Cesium.Cartesian3 | undefined {
    const entity = this.source.entities.getById(`unit:${uid}`)
    return entity?.position?.getValue(Cesium.JulianDate.now())
  }

  setCategoryVisible(category: UnitCategory, show: boolean, units: Unit[]): void {
    for (const u of units) {
      if (u.category !== category) continue
      const entity = this.source.entities.getById(`unit:${u.uid}`)
      if (entity) entity.show = show
    }
  }

  clear(): void {
    this.source.entities.removeAll()
  }
}
