import * as Cesium from 'cesium'
import { crispTextImage } from './streets'

// ---------------------------------------------------------------------------
// TWIN layer: a hand-authored architectural digital twin of a landmark
// structure, rendered from a TwinDefinition JSON (HABS drawings distilled to
// walls / windows / doors / columns / stairs / shafts in local building
// meters). The renderer transforms local coordinates — origin at the SW-most
// footprint corner, +X along the front facade, +Y into the building — to
// world space via origin lon/lat + bearingDeg, and stacks everything on the
// caller's groundZ. Look matches the KeyStone tactical console: cyan lines,
// glass fills, amber accents.
// ---------------------------------------------------------------------------

// ----- FROZEN TwinDefinition schema (authors + renderer build on this) -----

export interface TwinOrigin {
  lat: number
  lon: number
}

export interface TwinFootprint {
  widthM: number
  depthM: number
}

export interface TwinLevel {
  name: string
  z0M: number
  heightM: number
}

export interface TwinWall {
  x0: number
  y0: number
  x1: number
  y1: number
  z0M: number
  heightM: number
  thickM: number
}

export interface TwinWindowRun {
  /** Index into walls. */
  wall: number
  /** Along the wall from (x0, y0) to the first window's start. */
  offsetM: number
  /** Sill height above the wall's z0 (or the referenced level's z0). */
  sillM: number
  wM: number
  hM: number
  count: number
  /** Center-to-center spacing. */
  pitchM: number
  /** Indices into levels — the run repeats on each. */
  levels: number[]
}

export interface TwinDoor {
  wall: number
  offsetM: number
  wM: number
  hM: number
  label: string
}

export interface TwinColumn {
  x: number
  y: number
  rM: number
  z0M: number
  heightM: number
  count?: number
  dx?: number
  dy?: number
}

export interface TwinStair {
  kind: 'spiral' | 'straight'
  x: number
  y: number
  rM?: number
  wM?: number
  z0M: number
  topM: number
  label: string
}

export interface TwinFireEscape {
  wall: number
  offsetM: number
  wM: number
  z0M: number
  topM: number
}

export interface TwinDome {
  x: number
  y: number
  rM: number
  baseM: number
}

export interface TwinShaft {
  x: number
  y: number
  wM: number
  dM: number
  z0M: number
  topM: number
  label: string
}

export interface TwinRoof {
  kind: 'flat' | 'gable' | 'pediment'
  heightM: number
}

export interface TwinDefinition {
  name: string
  /** Substring of incident.address, uppercase. */
  matchAddress: string
  origin: TwinOrigin
  /** Rotation of local +Y (building north-wall direction), deg from true north CW. */
  bearingDeg: number
  footprint: TwinFootprint
  levels: TwinLevel[]
  walls: TwinWall[]
  windows: TwinWindowRun[]
  doors: TwinDoor[]
  columns: TwinColumn[]
  stairs: TwinStair[]
  fireEscapes: TwinFireEscape[]
  dome?: TwinDome
  shafts: TwinShaft[]
  roof?: TwinRoof
  /** Citation, e.g. "HABS NY-470 sheets 3-7, Library of Congress, public domain". */
  source: string
}

// ----- palette (KeyStone dark tactical) ------------------------------------

const CYAN = Cesium.Color.fromCssColorString('#22d3ee')
const AMBER = Cesium.Color.fromCssColorString('#f59e0b')
const WALL_FILL = Cesium.Color.fromCssColorString('#334155').withAlpha(0.42)
const WALL_EDGE = CYAN.withAlpha(0.55)
const GLASS_FILL = Cesium.Color.fromCssColorString('#0b1420').withAlpha(0.85)
const GLASS_EDGE = CYAN.withAlpha(0.85)
const DOOR_FILL = Cesium.Color.fromCssColorString('#0b1420').withAlpha(0.7)
const DOOR_EDGE = AMBER.withAlpha(0.95)
const LEVEL_FILL = Cesium.Color.fromCssColorString('#7dd3fc').withAlpha(0.08)
const LEVEL_EDGE = CYAN.withAlpha(0.22)
const COLUMN_FILL = Cesium.Color.fromCssColorString('#475569').withAlpha(0.5)
const COLUMN_EDGE = CYAN.withAlpha(0.4)
const SHAFT_FILL = CYAN.withAlpha(0.12)
const SHAFT_EDGE = CYAN.withAlpha(0.6)
const STAIR_FILL = Cesium.Color.fromCssColorString('#64748b').withAlpha(0.55)
const STAIR_LINE = CYAN.withAlpha(0.85)
const ESCAPE_LINE = AMBER.withAlpha(0.9)
const ESCAPE_PLATFORM = AMBER.withAlpha(0.3)
const DOME_FILL = Cesium.Color.fromCssColorString('#334155').withAlpha(0.35)
const DOME_EDGE = CYAN.withAlpha(0.5)

const LABEL_CYAN = '#a5f3fc'
const LABEL_AMBER = '#fcd34d'

// ----- local building frame → world ----------------------------------------

interface V2 {
  x: number
  y: number
}

/**
 * Planar meters→degrees transform (same small-angle pattern as
 * viewLock.offsetDeg): local +Y points at bearingDeg from true north (CW),
 * local +X at bearingDeg + 90 — so east = x·cosB + y·sinB and
 * north = −x·sinB + y·cosB. All heights are groundZ + local z.
 */
class LocalFrame {
  private readonly sinB: number
  private readonly cosB: number
  private readonly lonM: number
  private readonly latM = 111_320

  constructor(
    private readonly origin: TwinOrigin,
    bearingDeg: number,
    private readonly groundZ: number,
  ) {
    const rad = Cesium.Math.toRadians(bearingDeg)
    this.sinB = Math.sin(rad)
    this.cosB = Math.cos(rad)
    this.lonM = 111_320 * Math.cos(Cesium.Math.toRadians(origin.lat))
  }

  toLonLat(x: number, y: number): { lon: number; lat: number } {
    const east = x * this.cosB + y * this.sinB
    const north = -x * this.sinB + y * this.cosB
    return { lon: this.origin.lon + east / this.lonM, lat: this.origin.lat + north / this.latM }
  }

  /** World Cartesian at local (x, y) and local z above ground. */
  toCart(x: number, y: number, zLocal: number): Cesium.Cartesian3 {
    const ll = this.toLonLat(x, y)
    return Cesium.Cartesian3.fromDegrees(ll.lon, ll.lat, this.groundZ + zLocal)
  }

  /** Absolute (above-ellipsoid) height for a local z. */
  z(zLocal: number): number {
    return this.groundZ + zLocal
  }
}

// ----- geometry helpers -----------------------------------------------------

/** Plan-rectangle corners of a slab along centerline p0→p1 with half-thickness. */
function slabCorners(p0: V2, p1: V2, halfT: number): V2[] {
  const dx = p1.x - p0.x
  const dy = p1.y - p0.y
  const len = Math.hypot(dx, dy) || 1e-9
  const nx = (-dy / len) * halfT
  const ny = (dx / len) * halfT
  return [
    { x: p0.x + nx, y: p0.y + ny },
    { x: p1.x + nx, y: p1.y + ny },
    { x: p1.x - nx, y: p1.y - ny },
    { x: p0.x - nx, y: p0.y - ny },
  ]
}

/** Axis-aligned plan rectangle centered at (cx, cy). */
function rectCorners(cx: number, cy: number, halfW: number, halfD: number): V2[] {
  return [
    { x: cx - halfW, y: cy - halfD },
    { x: cx + halfW, y: cy - halfD },
    { x: cx + halfW, y: cy + halfD },
    { x: cx - halfW, y: cy + halfD },
  ]
}

function hierarchyOf(frame: LocalFrame, corners: V2[]): Cesium.PolygonHierarchy {
  const flat: number[] = []
  for (const c of corners) {
    const ll = frame.toLonLat(c.x, c.y)
    flat.push(ll.lon, ll.lat)
  }
  return new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(flat))
}

function boxFill(
  frame: LocalFrame,
  corners: V2[],
  z0Local: number,
  z1Local: number,
  color: Cesium.Color,
): Cesium.GeometryInstance {
  return new Cesium.GeometryInstance({
    geometry: new Cesium.PolygonGeometry({
      polygonHierarchy: hierarchyOf(frame, corners),
      height: frame.z(z0Local),
      extrudedHeight: frame.z(z1Local),
      vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
    }),
    attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
  })
}

function boxOutline(
  frame: LocalFrame,
  corners: V2[],
  z0Local: number,
  z1Local: number,
  color: Cesium.Color,
): Cesium.GeometryInstance {
  return new Cesium.GeometryInstance({
    geometry: new Cesium.PolygonOutlineGeometry({
      polygonHierarchy: hierarchyOf(frame, corners),
      height: frame.z(z0Local),
      extrudedHeight: frame.z(z1Local),
    }),
    attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
  })
}

/** Per-wall derived frame: start point, unit direction, exterior normal, length. */
interface WallFrame {
  wall: TwinWall
  p0: V2
  dir: V2
  nExt: V2
  len: number
}

function buildWallFrames(def: TwinDefinition): WallFrame[] {
  const cx = def.footprint.widthM / 2
  const cy = def.footprint.depthM / 2
  return (def.walls ?? []).map((wall) => {
    const p0 = { x: wall.x0, y: wall.y0 }
    const dx = wall.x1 - wall.x0
    const dy = wall.y1 - wall.y0
    const len = Math.hypot(dx, dy) || 1e-9
    const dir = { x: dx / len, y: dy / len }
    // Left normal, flipped to point AWAY from the footprint centroid — the
    // exterior face windows / doors / fire escapes hang on.
    let nExt = { x: -dir.y, y: dir.x }
    const mid = { x: (wall.x0 + wall.x1) / 2, y: (wall.y0 + wall.y1) / 2 }
    if (nExt.x * (mid.x - cx) + nExt.y * (mid.y - cy) < 0) nExt = { x: -nExt.x, y: -nExt.y }
    return { wall, p0, dir, nExt, len }
  })
}

/** Point `s` meters along a wall, pushed `out` meters along its exterior normal. */
function alongWall(wf: WallFrame, s: number, out: number): V2 {
  return { x: wf.p0.x + wf.dir.x * s + wf.nExt.x * out, y: wf.p0.y + wf.dir.y * s + wf.nExt.y * out }
}

const MAX_STAIR_STEPS = 240

// ----- the layer ------------------------------------------------------------

export class TwinLayer {
  private readonly viewer: Cesium.Viewer
  private readonly source = new Cesium.CustomDataSource('twin-layer')
  private primitives: Cesium.Primitive[] = []
  private visible = true

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer
    void viewer.dataSources.add(this.source)
  }

  /** Build the full twin at groundZ (absolute meters above the ellipsoid). */
  async load(def: TwinDefinition, groundZ: number): Promise<void> {
    this.clear()
    const frame = new LocalFrame(def.origin, def.bearingDeg, groundZ)
    const wallFrames = buildWallFrames(def)
    const fills: Cesium.GeometryInstance[] = []
    const outlines: Cesium.GeometryInstance[] = []

    this.buildLevels(def, frame, fills, outlines)
    this.buildWalls(frame, wallFrames, fills, outlines)
    this.buildWindows(def, frame, wallFrames, fills, outlines)
    this.buildDoors(def, frame, wallFrames, fills, outlines)
    this.buildColumns(def, frame, fills, outlines)
    this.buildStairs(def, frame, fills, outlines)
    this.buildFireEscapes(def, frame, wallFrames, fills)
    this.buildShafts(def, frame, fills, outlines)
    if (def.dome) this.buildDome(def.dome, frame, fills, outlines)
    if (def.roof) this.buildRoof(def, def.roof, frame, fills, outlines)

    if (fills.length) {
      const p = new Cesium.Primitive({
        geometryInstances: fills,
        appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, closed: true }),
        asynchronous: true,
      })
      this.viewer.scene.primitives.add(p)
      this.primitives.push(p)
    }
    if (outlines.length) {
      const p = new Cesium.Primitive({
        geometryInstances: outlines,
        appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true }),
        asynchronous: true,
      })
      this.viewer.scene.primitives.add(p)
      this.primitives.push(p)
    }
    this.applyVisibility()
  }

  setVisible(show: boolean): void {
    this.visible = show
    this.applyVisibility()
  }

  clear(): void {
    for (const p of this.primitives) this.viewer.scene.primitives.remove(p)
    this.primitives = []
    this.source.entities.removeAll()
  }

  private applyVisibility(): void {
    for (const p of this.primitives) p.show = this.visible
    this.source.show = this.visible
  }

  // ----- element builders ---------------------------------------------------

  /** Thin translucent slab + edge ring per level (basements included). */
  private buildLevels(
    def: TwinDefinition,
    frame: LocalFrame,
    fills: Cesium.GeometryInstance[],
    outlines: Cesium.GeometryInstance[],
  ): void {
    const { widthM, depthM } = def.footprint
    const corners = rectCorners(widthM / 2, depthM / 2, widthM / 2, depthM / 2)
    for (const lvl of def.levels ?? []) {
      fills.push(boxFill(frame, corners, lvl.z0M, lvl.z0M + 0.1, LEVEL_FILL))
      outlines.push(boxOutline(frame, corners, lvl.z0M, lvl.z0M + 0.1, LEVEL_EDGE))
    }
  }

  /** Extruded thickness boxes: translucent slate fill + cyan edges. */
  private buildWalls(
    frame: LocalFrame,
    wallFrames: WallFrame[],
    fills: Cesium.GeometryInstance[],
    outlines: Cesium.GeometryInstance[],
  ): void {
    for (const wf of wallFrames) {
      const w = wf.wall
      const corners = slabCorners(wf.p0, { x: w.x1, y: w.y1 }, Math.max(0.03, w.thickM / 2))
      fills.push(boxFill(frame, corners, w.z0M, w.z0M + w.heightM, WALL_FILL))
      outlines.push(boxOutline(frame, corners, w.z0M, w.z0M + w.heightM, WALL_EDGE))
    }
  }

  /**
   * Window runs: `count` glass quads at `pitchM` centers, sitting 0.15 m
   * proud of the exterior wall face, repeated on every referenced level.
   * Quads that would run past the wall end are skipped.
   */
  private buildWindows(
    def: TwinDefinition,
    frame: LocalFrame,
    wallFrames: WallFrame[],
    fills: Cesium.GeometryInstance[],
    outlines: Cesium.GeometryInstance[],
  ): void {
    for (const run of def.windows ?? []) {
      const wf = run.wall >= 0 && run.wall < wallFrames.length ? wallFrames[run.wall] : undefined
      if (!wf) continue
      const pitch = run.pitchM > 0 ? run.pitchM : run.wM + 0.6
      const n = Math.max(1, Math.round(run.count))
      const proud = wf.wall.thickM / 2 + 0.15
      const levelIdxs = run.levels && run.levels.length ? run.levels : [-1]
      for (const li of levelIdxs) {
        const lvl = li >= 0 && li < (def.levels?.length ?? 0) ? def.levels[li] : undefined
        if (li >= 0 && !lvl) continue
        const zBase = (lvl ? lvl.z0M : wf.wall.z0M) + run.sillM
        for (let k = 0; k < n; k++) {
          const s0 = run.offsetM + k * pitch
          if (s0 + run.wM > wf.len + 0.01) break // never spill past the wall
          const a = alongWall(wf, s0, proud)
          const b = alongWall(wf, s0 + run.wM, proud)
          const corners = slabCorners(a, b, 0.03)
          fills.push(boxFill(frame, corners, zBase, zBase + run.hM, GLASS_FILL))
          outlines.push(boxOutline(frame, corners, zBase, zBase + run.hM, GLASS_EDGE))
        }
      }
    }
  }

  /** Taller quads with amber frames + floating door labels. */
  private buildDoors(
    def: TwinDefinition,
    frame: LocalFrame,
    wallFrames: WallFrame[],
    fills: Cesium.GeometryInstance[],
    outlines: Cesium.GeometryInstance[],
  ): void {
    for (const door of def.doors ?? []) {
      const wf = door.wall >= 0 && door.wall < wallFrames.length ? wallFrames[door.wall] : undefined
      if (!wf) continue
      if (door.offsetM + door.wM > wf.len + 0.01) continue
      const proud = wf.wall.thickM / 2 + 0.08
      const a = alongWall(wf, door.offsetM, proud)
      const b = alongWall(wf, door.offsetM + door.wM, proud)
      const corners = slabCorners(a, b, 0.04)
      const z0 = wf.wall.z0M
      fills.push(boxFill(frame, corners, z0, z0 + door.hM, DOOR_FILL))
      outlines.push(boxOutline(frame, corners, z0, z0 + door.hM, DOOR_EDGE))
      const mid = alongWall(wf, door.offsetM + door.wM / 2, proud + 0.3)
      this.source.entities.add({
        position: frame.toCart(mid.x, mid.y, z0 + door.hM + 0.8),
        billboard: {
          image: crispTextImage(door.label, LABEL_AMBER, 18),
          scale: 0.5,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
    }
  }

  /** Cylinders; count + dx/dy spacing makes a colonnade from one record. */
  private buildColumns(
    def: TwinDefinition,
    frame: LocalFrame,
    fills: Cesium.GeometryInstance[],
    outlines: Cesium.GeometryInstance[],
  ): void {
    for (const col of def.columns ?? []) {
      const count = Math.max(1, Math.round(col.count ?? 1))
      for (let i = 0; i < count; i++) {
        const cx = col.x + i * (col.dx ?? 0)
        const cy = col.y + i * (col.dy ?? 0)
        const center = frame.toCart(cx, cy, col.z0M + col.heightM / 2)
        const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(center)
        fills.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.CylinderGeometry({
              length: col.heightM,
              topRadius: col.rM,
              bottomRadius: col.rM,
              slices: 20,
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            modelMatrix,
            attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(COLUMN_FILL) },
          }),
        )
        outlines.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.CylinderOutlineGeometry({
              length: col.heightM,
              topRadius: col.rM,
              bottomRadius: col.rM,
              slices: 20,
              numberOfVerticalLines: 6,
            }),
            modelMatrix,
            attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(COLUMN_EDGE) },
          }),
        )
      }
    }
  }

  /**
   * Spiral: helix polyline (24 pts/turn × 3 turns) around a center pole.
   * Straight: stacked thin step slabs climbing +Y from (x, y).
   */
  private buildStairs(
    def: TwinDefinition,
    frame: LocalFrame,
    fills: Cesium.GeometryInstance[],
    outlines: Cesium.GeometryInstance[],
  ): void {
    for (const st of def.stairs ?? []) {
      const rise = st.topM - st.z0M
      if (rise <= 0) continue
      if (st.kind === 'spiral') {
        const r = st.rM ?? 1.2
        const turns = 3
        const perTurn = 24
        const total = turns * perTurn
        const pts: Cesium.Cartesian3[] = []
        for (let i = 0; i <= total; i++) {
          const theta = (i / perTurn) * 2 * Math.PI
          const z = st.z0M + (rise * i) / total
          pts.push(frame.toCart(st.x + r * Math.cos(theta), st.y + r * Math.sin(theta), z))
        }
        this.source.entities.add({
          polyline: { positions: pts, width: 2, material: STAIR_LINE },
        })
        // Center pole.
        const center = frame.toCart(st.x, st.y, st.z0M + rise / 2)
        fills.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.CylinderGeometry({
              length: rise,
              topRadius: 0.08,
              bottomRadius: 0.08,
              slices: 10,
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(center),
            attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(STAIR_FILL) },
          }),
        )
      } else {
        const w = st.wM ?? 1.1
        const stepRise = 0.18
        const tread = 0.28
        const n = Math.min(MAX_STAIR_STEPS, Math.max(1, Math.ceil(rise / stepRise)))
        for (let i = 0; i < n; i++) {
          const zTop = st.z0M + (rise * (i + 1)) / n
          const y0 = st.y + i * tread
          const corners = rectCorners(st.x, y0 + tread / 2, w / 2, tread / 2)
          fills.push(boxFill(frame, corners, zTop - 0.06, zTop, STAIR_FILL))
        }
        outlines.push(
          boxOutline(
            frame,
            rectCorners(st.x, st.y + (n * tread) / 2, w / 2, (n * tread) / 2),
            st.z0M,
            st.topM,
            LEVEL_EDGE,
          ),
        )
      }
      this.source.entities.add({
        position: frame.toCart(st.x, st.y, st.topM + 0.6),
        billboard: {
          image: crispTextImage(st.label, LABEL_CYAN, 18),
          scale: 0.5,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
    }
  }

  /** Zigzag ladder polyline + a platform slab at each level crossing, 0.6 m
   *  outside the wall face. */
  private buildFireEscapes(
    def: TwinDefinition,
    frame: LocalFrame,
    wallFrames: WallFrame[],
    fills: Cesium.GeometryInstance[],
  ): void {
    for (const fe of def.fireEscapes ?? []) {
      const wf = fe.wall >= 0 && fe.wall < wallFrames.length ? wallFrames[fe.wall] : undefined
      if (!wf) continue
      const out = wf.wall.thickM / 2 + 0.6
      const sA = fe.offsetM
      const sB = fe.offsetM + fe.wM
      // Level crossings inside the escape's span; synthesize landings when the
      // definition has none in range so short escapes still read as ladders.
      const crossings = (def.levels ?? [])
        .map((l) => l.z0M)
        .filter((z) => z > fe.z0M + 0.5 && z <= fe.topM + 0.01)
        .sort((a, b) => a - b)
      if (!crossings.length) {
        for (let z = fe.z0M + 3; z < fe.topM; z += 3) crossings.push(z)
      }
      const pts: Cesium.Cartesian3[] = []
      let side = 0
      const push = (s: number, z: number) => {
        const p = alongWall(wf, s, out)
        pts.push(frame.toCart(p.x, p.y, z))
      }
      push(sA, fe.z0M)
      for (const z of crossings) {
        side = 1 - side
        push(side ? sB : sA, z)
      }
      side = 1 - side
      push(side ? sB : sA, fe.topM)
      this.source.entities.add({
        polyline: { positions: pts, width: 2, material: ESCAPE_LINE },
      })
      for (const z of crossings) {
        const a = alongWall(wf, sA, out)
        const b = alongWall(wf, sB, out)
        fills.push(boxFill(frame, slabCorners(a, b, 0.45), z - 0.08, z, ESCAPE_PLATFORM))
      }
    }
  }

  /** Vertical translucent boxes + label billboard at the shaft head. */
  private buildShafts(
    def: TwinDefinition,
    frame: LocalFrame,
    fills: Cesium.GeometryInstance[],
    outlines: Cesium.GeometryInstance[],
  ): void {
    for (const sh of def.shafts ?? []) {
      const corners = rectCorners(sh.x, sh.y, sh.wM / 2, sh.dM / 2)
      fills.push(boxFill(frame, corners, sh.z0M, sh.topM, SHAFT_FILL))
      outlines.push(boxOutline(frame, corners, sh.z0M, sh.topM, SHAFT_EDGE))
      this.source.entities.add({
        position: frame.toCart(sh.x, sh.y, sh.topM + 0.6),
        billboard: {
          image: crispTextImage(sh.label, LABEL_CYAN, 18),
          scale: 0.5,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
    }
  }

  /** Top half-ellipsoid clamped at baseM. */
  private buildDome(
    dome: TwinDome,
    frame: LocalFrame,
    fills: Cesium.GeometryInstance[],
    outlines: Cesium.GeometryInstance[],
  ): void {
    const radii = new Cesium.Cartesian3(dome.rM, dome.rM, dome.rM)
    const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(
      frame.toCart(dome.x, dome.y, dome.baseM),
    )
    fills.push(
      new Cesium.GeometryInstance({
        geometry: new Cesium.EllipsoidGeometry({
          radii,
          minimumCone: 0,
          maximumCone: Cesium.Math.PI_OVER_TWO,
          stackPartitions: 24,
          slicePartitions: 32,
          vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
        }),
        modelMatrix,
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(DOME_FILL) },
      }),
    )
    outlines.push(
      new Cesium.GeometryInstance({
        geometry: new Cesium.EllipsoidOutlineGeometry({
          radii,
          minimumCone: 0,
          maximumCone: Cesium.Math.PI_OVER_TWO,
          stackPartitions: 6,
          slicePartitions: 16,
        }),
        modelMatrix,
        attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(DOME_EDGE) },
      }),
    )
  }

  /**
   * flat: roof slab + parapet wireframe. gable/pediment: triangular prism
   * across the front width — built as stacked shrinking slabs (glass look)
   * with cyan gable-end triangles and a ridge line. A pediment only runs a
   * short way back from the front facade; a gable spans the full depth.
   */
  private buildRoof(
    def: TwinDefinition,
    roof: TwinRoof,
    frame: LocalFrame,
    fills: Cesium.GeometryInstance[],
    outlines: Cesium.GeometryInstance[],
  ): void {
    const { widthM, depthM } = def.footprint
    const base = Math.max(
      0,
      ...(def.levels ?? []).map((l) => l.z0M + l.heightM),
      ...(def.walls ?? []).map((w) => w.z0M + w.heightM),
    )
    if (roof.kind === 'flat') {
      const corners = rectCorners(widthM / 2, depthM / 2, widthM / 2, depthM / 2)
      fills.push(boxFill(frame, corners, base, base + 0.15, WALL_FILL))
      outlines.push(boxOutline(frame, corners, base, base + Math.max(0.15, roof.heightM), WALL_EDGE))
      return
    }
    const depthUsed = roof.kind === 'gable' ? depthM : Math.min(1.6, depthM * 0.2)
    const layers = 10
    for (let i = 0; i < layers; i++) {
      const f0 = i / layers
      const f1 = (i + 1) / layers
      const half = (widthM / 2) * (1 - (f0 + f1) / 2)
      const corners = rectCorners(widthM / 2, depthUsed / 2, Math.max(0.05, half), depthUsed / 2)
      fills.push(boxFill(frame, corners, base + roof.heightM * f0, base + roof.heightM * f1, WALL_FILL))
    }
    // Gable-end triangles + ridge in cyan.
    for (const y of [0, depthUsed]) {
      this.source.entities.add({
        polyline: {
          positions: [
            frame.toCart(0, y, base),
            frame.toCart(widthM, y, base),
            frame.toCart(widthM / 2, y, base + roof.heightM),
            frame.toCart(0, y, base),
          ],
          width: 2,
          material: WALL_EDGE,
        },
      })
    }
    this.source.entities.add({
      polyline: {
        positions: [
          frame.toCart(widthM / 2, 0, base + roof.heightM),
          frame.toCart(widthM / 2, depthUsed, base + roof.heightM),
        ],
        width: 2,
        material: WALL_EDGE,
      },
    })
  }
}

// ----- twin lookup ----------------------------------------------------------

interface TwinIndexEntry {
  file: string
  matchAddress: string
}

/**
 * Find the twin definition matching an incident address: fetch
 * /twins/index.json ([{ file, matchAddress }]), match by uppercase substring,
 * then fetch /twins/<file>. Missing index, missing file, or bad JSON all
 * resolve to null — twins are a bonus layer, never a failure mode.
 */
export async function fetchTwinForAddress(address: string): Promise<TwinDefinition | null> {
  try {
    const idxRes = await fetch('/twins/index.json')
    if (!idxRes.ok) return null
    const idx = (await idxRes.json()) as TwinIndexEntry[]
    if (!Array.isArray(idx)) return null
    const upper = address.toUpperCase()
    const hit = idx.find(
      (e) =>
        e &&
        typeof e.matchAddress === 'string' &&
        typeof e.file === 'string' &&
        upper.includes(e.matchAddress.toUpperCase()),
    )
    if (!hit) return null
    const defRes = await fetch(`/twins/${hit.file}`)
    if (!defRes.ok) return null
    const def = (await defRes.json()) as TwinDefinition
    if (!def || typeof def !== 'object' || !def.origin || !def.footprint) return null
    return def
  } catch {
    return null
  }
}
