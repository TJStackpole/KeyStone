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
  nypd: svgIcon(`<circle cx="13" cy="13" r="10" fill="#2563eb" ${STROKE}/>`),
  esu: svgIcon(`<path d="M13 2 L24 13 L13 24 L2 13 Z" fill="#2563eb" ${STROKE}/>`),
  oem: svgIcon(`<path d="M13 2.5 L23.5 10.2 L19.5 22.5 L6.5 22.5 L2.5 10.2 Z" fill="#ea580c" ${STROKE}/>`),
  drone: svgIcon(
    `<circle cx="7" cy="7" r="4.4" fill="none" stroke="#22d3ee" stroke-width="1.6"/>` +
      `<circle cx="19" cy="7" r="4.4" fill="none" stroke="#22d3ee" stroke-width="1.6"/>` +
      `<circle cx="7" cy="19" r="4.4" fill="none" stroke="#22d3ee" stroke-width="1.6"/>` +
      `<circle cx="19" cy="19" r="4.4" fill="none" stroke="#22d3ee" stroke-width="1.6"/>` +
      `<rect x="10.5" y="10.5" width="5" height="5" rx="1" fill="#22d3ee"/>`,
  ),
  ff: personIcon('#ef4444'),
  officer: personIcon('#3b82f6'),
  medic: personIcon('#60a5fa'),
  unknown: svgIcon(`<circle cx="13" cy="13" r="9" fill="#475569" ${STROKE}/><circle cx="13" cy="13" r="3" fill="#e2e8f0"/>`),
}

/** Dismounted-member glyph: smaller than apparatus, agency-colored. */
function personIcon(color: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
    `<circle cx="8" cy="4.4" r="2.7" fill="${color}" stroke="#e2e8f0" stroke-width="1"/>` +
    `<path d="M3.5 14.6 a4.5 4.5 0 0 1 9 0 Z" fill="${color}" stroke="#e2e8f0" stroke-width="1"/>` +
    `</svg>`
  return `data:image/svg+xml;base64,${btoa(svg)}`
}

const LABEL_FILL = Cesium.Color.fromCssColorString('#dbe4f0')
const LABEL_BG = Cesium.Color.fromCssColorString('#0a0e14').withAlpha(0.75)
const CYAN = Cesium.Color.fromCssColorString('#22d3ee')

/**
 * Renders the live unit picture as Cesium billboards with callsign labels.
 * Positions are SampledPositionProperties so movement between 2 s CoT updates
 * interpolates smoothly instead of teleporting.
 */
export class UnitLayer {
  private source = new Cesium.CustomDataSource('units')
  /** Callsign labels are hidden until the operator taps a unit (declutter). */
  private labeledUids = new Set<string>()

  constructor(viewer: Cesium.Viewer) {
    void viewer.dataSources.add(this.source)
  }

  /** Tap-to-toggle a unit's callsign label. Returns the new visibility. */
  toggleLabel(uid: string): boolean {
    const next = !this.labeledUids.has(uid)
    if (next) this.labeledUids.add(uid)
    else this.labeledUids.delete(uid)
    const entity = this.source.entities.getById(`unit:${uid}`)
    if (entity?.label) entity.label.show = new Cesium.ConstantProperty(next)
    return next
  }

  /** Reveal a unit's label (roster click-to-fly, transcript flash, etc.). */
  showLabel(uid: string): void {
    this.labeledUids.add(uid)
    const entity = this.source.entities.getById(`unit:${uid}`)
    if (entity?.label) entity.label.show = new Cesium.ConstantProperty(true)
  }

  upsert(unit: Unit, show = true): void {
    const id = `unit:${unit.uid}`
    const position = Cesium.Cartesian3.fromDegrees(unit.lon, unit.lat, unit.hae)
    const now = Cesium.JulianDate.now()
    // Street-level units clamp to the scene surface (CoT hae 0 floats above
    // photorealistic-tile streets); drones fly true altitude and interior
    // members hold their floor height inside the building.
    const clampRef =
      unit.category !== 'drone' && !(unit.floor && unit.floor > 0)
        ? Cesium.HeightReference.CLAMP_TO_GROUND
        : Cesium.HeightReference.NONE

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
          heightReference: clampRef,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: unit.floor && unit.floor > 0 ? `${unit.callsign} · FL ${unit.floor}` : unit.callsign,
          show: this.labeledUids.has(unit.uid), // hidden until tapped
          font: `600 11px 'JetBrains Mono', monospace`,
          fillColor: LABEL_FILL,
          showBackground: true,
          backgroundColor: LABEL_BG,
          backgroundPadding: new Cesium.Cartesian2(5, 3),
          pixelOffset: new Cesium.Cartesian2(0, -24),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: clampRef,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
      entity.show = show
    } else {
      ;(entity.position as Cesium.SampledPositionProperty).addSample(now, position)
      // Interior members carry their floor in the label ("E-6/1 · FL 4").
      const labelText = unit.floor && unit.floor > 0 ? `${unit.callsign} · FL ${unit.floor}` : unit.callsign
      if (entity.label && entity.label.text?.getValue(now) !== labelText) {
        entity.label.text = new Cesium.ConstantProperty(labelText)
      }
      if (entity.billboard) {
        entity.billboard.image = new Cesium.ConstantProperty(ICONS[unit.category] ?? ICONS.unknown)
        // Members transition exterior <-> interior; re-clamp accordingly.
        entity.billboard.heightReference = new Cesium.ConstantProperty(clampRef)
      }
      if (entity.label) entity.label.heightReference = new Cesium.ConstantProperty(clampRef)
    }

    if (unit.category === 'drone') this.updateDroneExtras(unit, show)
  }

  /**
   * Drones fly at true CoT altitude: render a dashed ground-projection line so
   * the operator can read where the aircraft sits over the street. (The FOV
   * cone was removed by user request — the VIDEO tab carries the feed itself.)
   */
  private updateDroneExtras(unit: Unit, show: boolean): void {
    const projId = `unit:${unit.uid}:proj`
    const dronePos = Cesium.Cartesian3.fromDegrees(unit.lon, unit.lat, unit.hae)
    // Overshoot below grade — the line is depth-tested, so tiles hide the
    // underground tail and it visually ends at the street on any provider.
    const groundPos = Cesium.Cartesian3.fromDegrees(unit.lon, unit.lat, -60)

    // Clean up FOV cones left by older builds.
    this.source.entities.removeById(`unit:${unit.uid}:cone`)

    let proj = this.source.entities.getById(projId)
    if (!proj) {
      proj = this.source.entities.add({
        id: projId,
        polyline: {
          positions: [dronePos, groundPos],
          width: 2,
          material: new Cesium.PolylineDashMaterialProperty({ color: CYAN.withAlpha(0.8), dashLength: 12 }),
        },
      })
    } else if (proj.polyline) {
      proj.polyline.positions = new Cesium.ConstantProperty([dronePos, groundPos])
    }
    proj.show = show
  }

  remove(uid: string): void {
    this.source.entities.removeById(`unit:${uid}`)
    this.source.entities.removeById(`unit:${uid}:proj`)
    this.source.entities.removeById(`unit:${uid}:cone`)
  }

  /** Transcript mention: pulse the unit's marker for ~3 s (F6/F7 spec). */
  flash(uid: string): void {
    const entity = this.source.entities.getById(`unit:${uid}`)
    if (!entity?.billboard) return
    entity.billboard.scale = new Cesium.ConstantProperty(1.8)
    if (entity.label) entity.label.fillColor = new Cesium.ConstantProperty(Cesium.Color.fromCssColorString('#fbbf24'))
    setTimeout(() => {
      if (entity.billboard) entity.billboard.scale = new Cesium.ConstantProperty(1)
      if (entity.label) entity.label.fillColor = new Cesium.ConstantProperty(LABEL_FILL)
    }, 3000)
  }

  /** Bodycam wall <-> globe sync: enlarge + tint the selected unit's marker. */
  setSelected(uid: string | null): void {
    for (const e of this.source.entities.values) {
      if (!e.billboard || !e.id.startsWith('unit:') || e.id.includes(':', 5)) continue
      const isSel = uid !== null && e.id === `unit:${uid}`
      e.billboard.scale = new Cesium.ConstantProperty(isSel ? 1.5 : 1)
      if (e.label) {
        e.label.fillColor = new Cesium.ConstantProperty(
          isSel ? Cesium.Color.fromCssColorString('#fbbf24') : LABEL_FILL,
        )
      }
    }
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
