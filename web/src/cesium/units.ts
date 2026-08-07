import * as Cesium from 'cesium'
import { lazy } from './lazy'
import { haversineMeters, nearestOnRing, pointInRing } from '../lib/geo'
import { getAppState } from '../state/store'
import type { Unit, UnitCategory } from '../types'
import type { SceneHandle } from './providers'

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
  // PAPD shield — facility jurisdiction (green per multi-agency taxonomy)
  papd: svgIcon(`<path d="M13 2.5 L22.5 6 V13 C22.5 18.6 18.6 22.6 13 24 C7.4 22.6 3.5 18.6 3.5 13 V6 Z" fill="#16a34a" ${STROKE}/>`),
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

const LABEL_FILL = lazy(() => Cesium.Color.fromCssColorString('#dbe4f0'))
const LABEL_BG = lazy(() => Cesium.Color.fromCssColorString('#0a0e14').withAlpha(0.75))
const CYAN = lazy(() => Cesium.Color.fromCssColorString('#22d3ee'))

/**
 * Renders the live unit picture as Cesium billboards with callsign labels.
 * Positions are SampledPositionProperties so movement between 2 s CoT updates
 * interpolates smoothly instead of teleporting.
 */
const TRAIL_COLOR: Record<string, string> = {
  FDNY: '#ef4444',
  EMS: '#3b82f6',
  NYPD: '#2563eb',
  PAPD: '#16a34a',
  OEM: '#ea580c',
  TAK: '#22d3ee',
}
const TRAIL_MAX_POINTS = 40
const VEHICLE_TRAIL_EXEMPT = new Set(['ff', 'officer', 'medic', 'drone'])
// Ground-clamped polylines re-tessellate on EVERY positions write — gate
// trail growth to real movement (sim rigs cover 21-26 m per 2 s tick, so a
// 50 m gate roughly halves the rebuilds with no visual cost at demo zoom).
const TRAIL_MIN_STEP_M = 50

// Per-agency color + glow material caches: allocating these per rebuild (and
// per pulse ring) churned GC for values that never change.
const agencyColorCache = new Map<string, Cesium.Color>()
function agencyColor(agency: string): Cesium.Color {
  let c = agencyColorCache.get(agency)
  if (!c) {
    c = Cesium.Color.fromCssColorString(TRAIL_COLOR[agency] ?? '#22d3ee')
    agencyColorCache.set(agency, c)
  }
  return c
}
const trailMaterialCache = new Map<string, Cesium.PolylineGlowMaterialProperty>()
function trailMaterial(agency: string): Cesium.PolylineGlowMaterialProperty {
  let m = trailMaterialCache.get(agency)
  if (!m) {
    m = new Cesium.PolylineGlowMaterialProperty({ color: agencyColor(agency).withAlpha(0.85), glowPower: 0.25 })
    trailMaterialCache.set(agency, m)
  }
  return m
}

const MAX_POSITION_SAMPLES = 120 // ~4 minutes at the 2 s CoT cadence

// Responding-unit pulse: an expanding, fading ring under every ENROUTE
// vehicle so active responders read at a glance. White ring texture tinted
// per-agency via billboard.color; scale+alpha ride one shared phase.
const PULSE_RING = svgIcon(
  `<circle cx="13" cy="13" r="10.5" fill="none" stroke="#ffffff" stroke-width="2.6"/>`,
)
const PULSE_PERIOD_MS = 1400
/** 0 -> 1 sawtooth-ish phase (eased) shared by every pulse ring. */
function pulsePhase(): number {
  return ((Date.now() % PULSE_PERIOD_MS) / PULSE_PERIOD_MS) ** 0.7
}

// Street-level markers bake a sampled ground height into their position
// samples instead of using CLAMP_TO_GROUND: a clamped billboard riding a
// SampledPositionProperty re-clamps on EVERY rendered frame while the unit
// moves, and with tileset collision on each re-clamp is a synchronous
// ray-pick against the city mesh — (marker + pulse) x 60 fps x every enroute
// vehicle was several ms of main thread per frame at first-alarm convergence.
// Baking costs ONE pick per unit per >10 m of travel, off the render loop.
const GROUND_RESAMPLE_M = 10

// Apparatus categories that park at the scene — they get a staged-spot
// marker on arrival and their marker pins there (GPS wander suppression).
const VEHICLES = new Set<UnitCategory>(['engine', 'ladder', 'battalion', 'rescue', 'ems', 'nypd', 'esu', 'papd', 'oem'])
/** Reported drift beyond this is a real reposition, not GPS noise. */
const STAGED_PIN_RADIUS_M = 30
const STAGED_PAD = svgIcon(
  `<circle cx="13" cy="13" r="10" fill="none" stroke="#f59e0b" stroke-width="2.2" stroke-dasharray="4.5 3.5"/>` +
    `<circle cx="13" cy="13" r="2.2" fill="#f59e0b"/>`,
)
const STAGED_LABEL_FILL = lazy(() => Cesium.Color.fromCssColorString('#fbbf24'))

export class UnitLayer {
  private source = new Cesium.CustomDataSource('units')
  /** Recent enroute positions per vehicle — the live response trail. */
  private trails = new Map<string, [number, number][]>()
  /** Sample timestamps per unit, so old SampledPositionProperty samples can
   *  be evicted — unbounded growth would leak memory over a long incident. */
  private sampleTimes = new Map<string, Cesium.JulianDate[]>()
  /** Callsign labels are hidden until the operator taps a unit (declutter). */
  private labeledUids = new Set<string>()
  /** Agency captured in each pulse ring's color closure — recreate on change. */
  private pulseAgency = new Map<string, string>()
  /** Where each apparatus parked on arrival — marker anchor + pin position. */
  private stagedAt = new Map<string, { lat: number; lon: number }>()
  /** Fire-building footprint rings — interior members snap inside them. */
  private interiorRings: number[][][] | null = null
  /** Baked street height per unit (see GROUND_RESAMPLE_M). viaGlobe marks a
   *  height sampled off the ellipsoid globe — a lie once the google upgrade
   *  hides that globe, so those entries resample instead of being trusted. */
  private groundHeights = new Map<string, { lat: number; lon: number; h: number; viaGlobe: boolean; isolate: boolean }>()

  /** Target footprint outer rings ([lon,lat][] each), or null to clear. */
  setInteriorBounds(rings: number[][][] | null): void {
    this.interiorRings = rings && rings.length ? rings : null
  }

  constructor(private handle: SceneHandle) {
    void handle.viewer.dataSources.add(this.source)
  }

  /**
   * Street height under a unit, from the same sources CLAMP_TO_GROUND
   * consults (collision tileset first, then the globe when it's shown), but
   * sampled once per CoT update instead of once per rendered frame. Returns
   * undefined when nothing is loaded to sample yet — the caller falls back
   * to real clamping until a height exists.
   */
  private groundHeightFor(uid: string, lat: number, lon: number): number | undefined {
    const scene = this.handle.viewer.scene
    const tileset = this.handle.buildingTileset
    // ISOLATE flattens the world: the city mesh is clipped away and the
    // globe IS the visible ground under exterior crews. Heights baked off
    // the hidden photorealistic streets (~-30 m) would sink/float markers in
    // every locked facade view — so isolate gets its own samples, and the
    // cache invalidates whenever the mode flips (applyUnitVisibility
    // re-upserts every unit on isolate on/off).
    const isolate = getAppState().isolateMode
    const cached = this.groundHeights.get(uid)
    if (
      cached &&
      cached.isolate === isolate &&
      !(cached.viaGlobe && !isolate && tileset && !scene.globe.show) &&
      haversineMeters(cached.lat, cached.lon, lat, lon) < GROUND_RESAMPLE_M
    ) {
      return cached.h
    }
    const carto = Cesium.Cartographic.fromDegrees(lon, lat)
    let h: number | undefined
    let viaGlobe = false
    if (isolate) {
      // Units share the SCHEMATIC's ground plane by construction: the same
      // z0 the isolate floor reference landed the building on. Sampling the
      // globe here could disagree with the building by the google-mode
      // offset (~26 m) and leave crews floating beside a grounded structure.
      h = getAppState().isolateFloors?.z0 ?? (scene.globe.show ? scene.globe.getHeight(carto) : undefined) ?? 0
      viaGlobe = true
    } else {
      h = tileset?.getHeight(carto, scene)
      if (h === undefined && scene.globe.show) {
        h = scene.globe.getHeight(carto)
        viaGlobe = true
      }
    }
    // No mesh streamed at this spot yet: reuse the last-known height (streets
    // are near-flat block to block) and retry on the next update.
    if (h === undefined) return cached?.h
    this.groundHeights.set(uid, { lat, lon, h, viaGlobe, isolate })
    return h
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
    const s = getAppState()
    const interior = unit.category === 'ff' && (unit.floor ?? 0) >= 1
    let lat = unit.lat
    let lon = unit.lon
    let hae = unit.hae

    // GPS accuracy — parked apparatus: the moment a rig arrives, remember
    // exactly where it parked, drop a staged-spot marker there, and PIN the
    // marker to that spot while reported positions merely wander around it.
    if (VEHICLES.has(unit.category)) {
      const arrived = !!unit.status && unit.status !== 'Enroute'
      const st = this.stagedAt.get(unit.uid)
      if (arrived) {
        if (!st) {
          this.stagedAt.set(unit.uid, { lat, lon })
          this.upsertStagedMarker(unit, lat, lon, show)
        } else if (haversineMeters(st.lat, st.lon, lat, lon) < STAGED_PIN_RADIUS_M) {
          lat = st.lat
          lon = st.lon
        } else {
          // Genuinely repositioned (new hydrant, ladder re-spot) — follow it.
          st.lat = lat
          st.lon = lon
          this.upsertStagedMarker(unit, lat, lon, show)
        }
      } else if (st) {
        // Back enroute (rewind / reassignment): the staged spot is history.
        this.stagedAt.delete(unit.uid)
        this.source.entities.removeById(`unit:${unit.uid}:staged`)
      }
    }

    // GPS accuracy — interior members: a member reported inside the building
    // must RENDER inside it. Snap strays to the nearest footprint edge and
    // nudge 1.5 m inboard; height comes from true street level + storey
    // geometry (floorRef / the isolate schematic) instead of raw CoT altitude.
    if (interior) {
      if (this.interiorRings && !this.interiorRings.some((r) => pointInRing(lon, lat, r))) {
        let best: [number, number] | null = null
        let bestRing: number[][] | null = null
        let bestD = Infinity
        for (const ring of this.interiorRings) {
          const p = nearestOnRing(lon, lat, ring)
          const d = haversineMeters(lat, lon, p[1], p[0])
          if (d < bestD) {
            bestD = d
            best = p
            bestRing = ring
          }
        }
        // Only rescue plausible strays — a member 100 m out is bad data, and
        // teleporting them onto the building would lie about it.
        if (best && bestRing && bestD < 60) {
          let avgLon = 0
          let avgLat = 0
          for (const [x, y] of bestRing) {
            avgLon += x
            avgLat += y
          }
          avgLon /= bestRing.length
          avgLat /= bestRing.length
          const cosLat = Math.cos((best[1] * Math.PI) / 180)
          const dxM = (avgLon - best[0]) * 111_320 * cosLat
          const dyM = (avgLat - best[1]) * 111_320
          const dM = Math.hypot(dxM, dyM)
          const frac = dM > 0 ? Math.min(1, 1.5 / dM) : 0
          lon = best[0] + (avgLon - best[0]) * frac
          lat = best[1] + (avgLat - best[1]) * frac
        }
      }
      const ref = s.isolateFloors ?? s.floorRef
      hae = ref
        ? ref.z0 + (Math.max(1, unit.floor ?? 1) - 0.5) * ref.storeyM
        : unit.hae + s.isolateLiftM
    }
    // Street-level units ride the scene surface (CoT hae 0 floats above
    // photorealistic-tile streets); drones fly true altitude and interior
    // members hold their floor height inside the building. The street height
    // is BAKED into the samples (see GROUND_RESAMPLE_M) — CLAMP_TO_GROUND is
    // only the fallback while no mesh has streamed in to sample.
    let clampRef = Cesium.HeightReference.NONE
    if (unit.category !== 'drone' && !(unit.floor && unit.floor > 0)) {
      const ground = this.groundHeightFor(unit.uid, lat, lon)
      if (ground !== undefined) hae = ground
      else clampRef = Cesium.HeightReference.CLAMP_TO_GROUND
    }
    const position = Cesium.Cartesian3.fromDegrees(lon, lat, hae)
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
      // Track the creation sample too — otherwise the eviction window can
      // never dislodge it and it anchors interpolation forever.
      this.sampleTimes.set(unit.uid, [Cesium.JulianDate.clone(now)])
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
          fillColor: LABEL_FILL(),
          showBackground: true,
          backgroundColor: LABEL_BG(),
          backgroundPadding: new Cesium.Cartesian2(5, 3),
          pixelOffset: new Cesium.Cartesian2(0, -24),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: clampRef,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
      entity.show = show
    } else {
      const sampled = entity.position as Cesium.SampledPositionProperty
      sampled.addSample(now, position)
      // Window the samples: evict everything older than the newest N.
      let times = this.sampleTimes.get(unit.uid)
      if (!times) {
        times = []
        this.sampleTimes.set(unit.uid, times)
      }
      times.push(Cesium.JulianDate.clone(now))
      while (times.length > MAX_POSITION_SAMPLES) {
        const old = times.shift()!
        sampled.removeSample(old)
      }
      // Visibility policy can change between updates (GPS toggle, a member
      // entering/leaving the building) — re-apply it every time (cheap bool).
      entity.show = show
      // Interior members carry their floor in the label ("E-6/1 · FL 4").
      const labelText = unit.floor && unit.floor > 0 ? `${unit.callsign} · FL ${unit.floor}` : unit.callsign
      if (entity.label && entity.label.text?.getValue(now) !== labelText) {
        entity.label.text = new Cesium.ConstantProperty(labelText)
      }
      // Only assign properties that actually CHANGED — replacing a
      // ConstantProperty every update forces Cesium to rebuild the billboard
      // batch for every unit every 2 s, which shows up as frame hitches.
      const icon = ICONS[unit.category] ?? ICONS.unknown
      if (entity.billboard) {
        if (entity.billboard.image?.getValue(now) !== icon) {
          entity.billboard.image = new Cesium.ConstantProperty(icon)
        }
        if (entity.billboard.heightReference?.getValue(now) !== clampRef) {
          // Members transition exterior <-> interior; re-clamp accordingly.
          entity.billboard.heightReference = new Cesium.ConstantProperty(clampRef)
        }
      }
      if (entity.label && entity.label.heightReference?.getValue(now) !== clampRef) {
        entity.label.heightReference = new Cesium.ConstantProperty(clampRef)
      }
    }

    if (unit.category === 'drone') this.updateDroneExtras(unit, show)
    this.updateTrail(unit, show)
    this.updatePulse(unit, show, entity.position as Cesium.PositionProperty, clampRef)
    // The staged-spot marker follows the unit's visibility policy.
    const staged = this.source.entities.getById(`unit:${unit.uid}:staged`)
    if (staged) staged.show = show
  }

  /** Dashed amber pad + "{callsign} STAGED" at the spot the rig parked. */
  private upsertStagedMarker(unit: Unit, lat: number, lon: number, show: boolean): void {
    const id = `unit:${unit.uid}:staged`
    const pos = Cesium.Cartesian3.fromDegrees(lon, lat)
    let e = this.source.entities.getById(id)
    if (!e) {
      e = this.source.entities.add({
        id,
        position: pos,
        billboard: {
          image: STAGED_PAD,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(300, 1, 4000, 0.45),
        },
        label: {
          text: `${unit.callsign} STAGED`,
          font: `600 9.5px 'JetBrains Mono', monospace`,
          fillColor: STAGED_LABEL_FILL(),
          showBackground: true,
          backgroundColor: LABEL_BG(),
          backgroundPadding: new Cesium.Cartesian2(4, 2),
          pixelOffset: new Cesium.Cartesian2(0, 14),
          verticalOrigin: Cesium.VerticalOrigin.TOP,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(300, 1, 3000, 0.5),
        },
      })
    } else {
      e.position = new Cesium.ConstantPositionProperty(pos)
    }
    e.show = show
  }

  /**
   * Pulsating ring under a GPS-tracked vehicle while it is ENROUTE — the
   * "this unit is actively responding" cue. Shares the unit's interpolated
   * position property, so it rides along the street with the marker; removed
   * the moment the unit arrives.
   */
  private updatePulse(
    unit: Unit,
    show: boolean,
    position: Cesium.PositionProperty,
    clampRef: Cesium.HeightReference,
  ): void {
    const pulseId = `unit:${unit.uid}:pulse`
    // EXPLICIT Enroute only: real ATAK phones never carry the status
    // extension, and a status-less phone sitting at the command post must not
    // pulse as "actively responding" for its whole stale window. The pulse is
    // also a LIVE cue — a paused replay's frozen picture gets none.
    const enroute = unit.status === 'Enroute' && !getAppState().replay.active
    if (VEHICLE_TRAIL_EXEMPT.has(unit.category) || !enroute) {
      this.source.entities.removeById(pulseId)
      this.pulseAgency.delete(unit.uid)
      return
    }
    let pulse = this.source.entities.getById(pulseId)
    // Units re-classify as richer CoT detail resolves (TAK -> FDNY) — the
    // ring must not keep the creation-time tint under a recolored marker.
    if (pulse && this.pulseAgency.get(unit.uid) !== unit.agency) {
      this.source.entities.removeById(pulseId)
      pulse = undefined
    }
    if (!pulse) {
      this.pulseAgency.set(unit.uid, unit.agency)
      const base = agencyColor(unit.agency)
      const scratch = new Cesium.Color()
      pulse = this.source.entities.add({
        id: pulseId,
        position,
        billboard: {
          image: PULSE_RING,
          // Expand 0.7x -> 2.1x while fading out; CallbackProperties update
          // vertex attributes only — no geometry rebuilds per frame.
          scale: new Cesium.CallbackProperty(() => 0.7 + 1.4 * pulsePhase(), false),
          color: new Cesium.CallbackProperty(
            () => Cesium.Color.fromAlpha(base, 0.9 * (1 - pulsePhase()), scratch),
            false,
          ),
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          heightReference: clampRef,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
    } else {
      // The marker's position property is recreated on entity re-create —
      // keep the ring pointed at the CURRENT one.
      if (pulse.position !== position) pulse.position = position
    }
    pulse.show = show
  }

  /**
   * Live response tracking: an agency-colored tail behind every vehicle that
   * is still ENROUTE, so convergence on the scene reads at a glance. Cleared
   * the moment the unit arrives (or GPS tracking hides it).
   */
  private updateTrail(unit: Unit, show: boolean): void {
    const trailId = `unit:${unit.uid}:trail`
    const enroute = !unit.status || unit.status === 'Enroute'
    if (VEHICLE_TRAIL_EXEMPT.has(unit.category) || !enroute) {
      this.trails.delete(unit.uid)
      this.source.entities.removeById(trailId)
      return
    }
    let buf = this.trails.get(unit.uid)
    if (!buf) {
      buf = []
      this.trails.set(unit.uid, buf)
    }
    const last = buf[buf.length - 1]
    let grew = false
    if (!last) {
      buf.push([unit.lon, unit.lat])
      grew = true
    } else {
      // Equirectangular meters — cheap, exact enough for a 50 m gate.
      const dxM = (unit.lon - last[0]) * 111_320 * Math.cos((unit.lat * Math.PI) / 180)
      const dyM = (unit.lat - last[1]) * 111_320
      if (dxM * dxM + dyM * dyM >= TRAIL_MIN_STEP_M * TRAIL_MIN_STEP_M) {
        buf.push([unit.lon, unit.lat])
        if (buf.length > TRAIL_MAX_POINTS) buf.shift()
        grew = true
      }
    }
    if (buf.length < 2) return
    // Ground-clamped polylines rebuild their shadow-volume primitive on every
    // positions assignment — only pay that when the trail actually changed.
    const existing = this.source.entities.getById(trailId)
    if (existing && !grew) {
      existing.show = show
      return
    }
    const positions = Cesium.Cartesian3.fromDegreesArray(buf.flat())
    let trail = this.source.entities.getById(trailId)
    if (!trail) {
      trail = this.source.entities.add({
        id: trailId,
        polyline: {
          positions,
          width: 3.5,
          material: trailMaterial(unit.agency),
          clampToGround: true,
        },
      })
    } else if (trail.polyline) {
      trail.polyline.positions = new Cesium.ConstantProperty(positions)
    }
    trail.show = show
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
          material: new Cesium.PolylineDashMaterialProperty({ color: CYAN().withAlpha(0.8), dashLength: 12 }),
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
    this.source.entities.removeById(`unit:${uid}:trail`)
    this.source.entities.removeById(`unit:${uid}:pulse`)
    this.source.entities.removeById(`unit:${uid}:staged`)
    this.trails.delete(uid)
    this.sampleTimes.delete(uid)
    this.pulseAgency.delete(uid)
    this.stagedAt.delete(uid)
    this.groundHeights.delete(uid)
  }

  /** Transcript mention: pulse the unit's marker for ~3 s (F6/F7 spec). */
  flash(uid: string): void {
    const entity = this.source.entities.getById(`unit:${uid}`)
    if (!entity?.billboard) return
    entity.billboard.scale = new Cesium.ConstantProperty(1.8)
    if (entity.label) entity.label.fillColor = new Cesium.ConstantProperty(Cesium.Color.fromCssColorString('#fbbf24'))
    setTimeout(() => {
      // Restore to the unit's CURRENT idle state — a hard reset here used to
      // clobber the selected-unit highlight applied while the flash ran.
      const selected = getAppState().selectedUnitUid === uid
      if (entity.billboard) entity.billboard.scale = new Cesium.ConstantProperty(selected ? 1.5 : 1)
      if (entity.label) {
        entity.label.fillColor = new Cesium.ConstantProperty(
          selected ? Cesium.Color.fromCssColorString('#fbbf24') : LABEL_FILL(),
        )
      }
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
          isSel ? Cesium.Color.fromCssColorString('#fbbf24') : LABEL_FILL(),
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
    this.trails.clear()
    this.sampleTimes.clear()
    this.pulseAgency.clear()
    this.stagedAt.clear()
    this.groundHeights.clear()
  }
}
