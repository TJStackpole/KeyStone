import * as Cesium from 'cesium'
import { deleteShape, exitGround, inspectBuildingAt, saveShape } from '../actions'
import { ShapeLayer, ZONE_STYLE } from '../cesium/shapes'
import { enterGroundView } from '../cesium/viewmode'
import { haversineMeters } from '../lib/geo'
import { getAppState, setAppState } from '../state/store'
import type { IcsShape, PostKind, ZoneKind } from '../types'

const ZONES: ZoneKind[] = ['hot', 'warm', 'cold', 'perimeter']
const POSTS: PostKind[] = ['icp', 'staging', 'triage', 'media', 'transport']

function newShapeId(prefix: string): string {
  return `WT-ICS-${prefix}-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 36).toString(36).toUpperCase()}`
}

/**
 * Globe drawing interactions: zone polygons (click vertices, Enter/double-click
 * to close, Esc cancels), post placement (single click), shape selection, and
 * draggable vertex editing on the selected zone. One instance per scene.
 */
export class DrawController {
  private handler: Cesium.ScreenSpaceEventHandler
  private draft: { lat: number; lon: number }[] = []
  private measurePoints: { lat: number; lon: number }[] = []
  private measureSource = new Cesium.CustomDataSource('measure')
  private draftSource = new Cesium.CustomDataSource('draw-draft')
  private handleSource = new Cesium.CustomDataSource('draw-handles')
  private dragIndex: number | null = null
  private keyListener = (e: KeyboardEvent) => this.onKey(e)

  constructor(private viewer: Cesium.Viewer, private shapes: ShapeLayer) {
    void viewer.dataSources.add(this.draftSource)
    void viewer.dataSources.add(this.handleSource)
    void viewer.dataSources.add(this.measureSource)
    this.handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
    this.handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => this.onLeftClick(e), Cesium.ScreenSpaceEventType.LEFT_CLICK)
    this.handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => this.onDoubleClick(e), Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
    this.handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => this.onLeftDown(e), Cesium.ScreenSpaceEventType.LEFT_DOWN)
    this.handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.MotionEvent) => this.onMouseMove(e), Cesium.ScreenSpaceEventType.MOUSE_MOVE)
    this.handler.setInputAction(() => this.onLeftUp(), Cesium.ScreenSpaceEventType.LEFT_UP)
    window.addEventListener('keydown', this.keyListener)
  }

  destroy(): void {
    this.handler.destroy()
    window.removeEventListener('keydown', this.keyListener)
  }

  // ------------------------------- picking ---------------------------------

  private groundPosition(screen: Cesium.Cartesian2): { lat: number; lon: number; hae: number } | null {
    const scene = this.viewer.scene
    let cartesian: Cesium.Cartesian3 | undefined
    if (scene.pickPositionSupported) {
      const picked = scene.pickPosition(screen)
      if (Cesium.defined(picked)) cartesian = picked
    }
    if (!cartesian) {
      cartesian = this.viewer.camera.pickEllipsoid(screen, scene.globe.ellipsoid)
    }
    if (!cartesian) return null
    const carto = Cesium.Cartographic.fromCartesian(cartesian)
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
      hae: carto.height,
    }
  }

  // ----------------------------- interactions ------------------------------

  private onLeftClick(e: Cesium.ScreenSpaceEventHandler.PositionedEvent): void {
    if (this.dragIndex !== null) return
    const tool = getAppState().drawTool
    const pos = this.groundPosition(e.position)
    if (!pos) return

    if (tool === 'measure') {
      this.measurePoints.push({ lat: pos.lat, lon: pos.lon })
      if (this.measurePoints.length === 2) {
        this.renderMeasure()
        this.measurePoints = []
        setAppState({ drawTool: null })
      }
      return
    }
    if (tool === 'collapse') {
      this.createCollapseZone()
      setAppState({ drawTool: null })
      return
    }
    if (tool === 'apparatus') {
      // Stays armed so the chief can lay out a whole staging line click by click.
      void this.placeApparatus(pos)
      return
    }
    if (tool === 'ground') {
      // Drop to eye height at the clicked spot, facing the incident.
      const inc = getAppState().incident
      enterGroundView(this.viewer, pos, inc ? { lat: inc.lat, lon: inc.lon } : undefined)
      setAppState({ drawTool: null, groundViewActive: true })
      return
    }
    if (tool && ZONES.includes(tool as ZoneKind)) {
      this.draft.push({ lat: pos.lat, lon: pos.lon })
      this.renderDraft(tool as ZoneKind)
      return
    }
    if (tool && POSTS.includes(tool as PostKind)) {
      const shape: IcsShape = {
        id: newShapeId(tool.toUpperCase()),
        kind: 'post',
        post: tool as PostKind,
        lat: pos.lat,
        lon: pos.lon,
        createdAt: new Date().toISOString(),
      }
      void saveShape(shape)
      setAppState({ drawTool: null })
      return
    }

    // No tool: select/deselect shapes, open drone feeds, sync bodycam wall.
    const picked = this.viewer.scene.pick(e.position) as { id?: Cesium.Entity } | undefined
    const entityId = picked?.id?.id
    if (typeof entityId === 'string' && entityId.startsWith('shape:')) {
      const shapeId = ShapeLayer.shapeIdFromEntityId(entityId)
      if (shapeId) {
        setAppState({ selectedShapeId: shapeId })
        this.renderHandles()
        return
      }
    }
    if (typeof entityId === 'string' && entityId.startsWith('unit:')) {
      const uid = entityId.replace(/^unit:/, '').replace(/:(proj|cone)$/, '')
      const unit = getAppState().units[uid]
      // Tap a unit to toggle its callsign label (labels are hidden by default).
      // dynamic import: scene.ts owns this controller, so a static import would cycle
      void import('../cesium/scene').then((m) => {
        m.getUnitLayer()?.toggleLabel(uid)
        if (unit && unit.agency === 'FDNY' && getAppState().utilityTab === 'video') {
          setAppState({ selectedUnitUid: uid })
          m.getUnitLayer()?.setSelected(uid)
        }
      })
      if (unit?.category === 'drone') setAppState({ utilityTab: 'video' })
      return
    }
    if (typeof entityId !== 'string' || !entityId.startsWith('handle:')) {
      setAppState({ selectedShapeId: null })
      this.renderHandles()
      // Tap-a-building: pull the public record (PLUTO, violations, C of O)
      // for whatever address sits under the click.
      if (getAppState().incident) void inspectBuildingAt(pos.lat, pos.lon)
    }
  }

  private onDoubleClick(e: Cesium.ScreenSpaceEventHandler.PositionedEvent): void {
    void e
    this.finishZone()
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    if (e.key === 'Enter') this.finishZone()
    if (e.key === 'Escape') {
      if (getAppState().groundViewActive) exitGround()
      this.cancelDraft()
      setAppState({ drawTool: null, selectedShapeId: null })
      this.renderHandles()
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const id = getAppState().selectedShapeId
      if (id) {
        void deleteShape(id)
        setAppState({ selectedShapeId: null })
        this.renderHandles()
      }
    }
  }

  private finishZone(): void {
    const tool = getAppState().drawTool
    if (!tool || !ZONES.includes(tool as ZoneKind) || this.draft.length < 3) return
    const shape: IcsShape = {
      id: newShapeId(`ZONE-${tool.toUpperCase()}`),
      kind: 'zone',
      zone: tool as ZoneKind,
      positions: [...this.draft],
      createdAt: new Date().toISOString(),
    }
    void saveShape(shape)
    this.cancelDraft()
    setAppState({ drawTool: null })
  }

  cancelDraft(): void {
    this.draft = []
    this.measurePoints = []
    this.measureSource.entities.removeAll()
    this.draftSource.entities.removeAll()
  }

  // ------------------------- chief tools (Phase 8+) --------------------------

  /** Two-point measure: glowing line + distance label (m + ft). Esc clears. */
  private renderMeasure(): void {
    const [a, b] = this.measurePoints
    this.measureSource.entities.removeAll()
    const meters = haversineMeters(a.lat, a.lon, b.lat, b.lon)
    const feet = meters * 3.28084
    const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 }
    this.measureSource.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray([a.lon, a.lat, b.lon, b.lat]),
        width: 4,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString('#22d3ee'),
          dashLength: 14,
        }),
        clampToGround: true,
      },
    })
    this.measureSource.entities.add({
      position: Cesium.Cartesian3.fromDegrees(mid.lon, mid.lat, 0),
      label: {
        text: `${Math.round(meters)} m · ${Math.round(feet)} ft`,
        font: `700 12px 'JetBrains Mono', monospace`,
        fillColor: Cesium.Color.fromCssColorString('#22d3ee'),
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#0a0e14').withAlpha(0.8),
        backgroundPadding: new Cesium.Cartesian2(7, 4),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
  }

  /**
   * Staging reservation: true-scale apparatus footprint at the click point,
   * auto-labeled with the next incoming unit (real next-due companies from
   * the server), oriented along the current camera heading so the chief can
   * line rigs up a street by looking down it.
   */
  private async placeApparatus(pos: { lat: number; lon: number; hae: number }): Promise<void> {
    let callsign = `E-${200 + Math.floor(Math.random() * 90)}`
    try {
      const res = await fetch('/api/staging/next')
      if (res.ok) callsign = ((await res.json()) as { callsign: string }).callsign
    } catch {
      // offline fallback keeps the tool usable
    }
    const headingDeg = (Cesium.Math.toDegrees(this.viewer.camera.heading) + 360) % 360
    void saveShape({
      id: `WT-ICS-STAGE-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 36).toString(36).toUpperCase()}`,
      kind: 'apparatus',
      callsign,
      lat: pos.lat,
      lon: pos.lon,
      heading: headingDeg,
      hae: Number.isFinite(pos.hae) ? pos.hae : 0,
      createdAt: new Date().toISOString(),
    })
  }

  /**
   * One-click collapse zone: FDNY rule-of-thumb radius of 1.5x building height
   * around the incident building, published like any hand-drawn hot zone.
   */
  private createCollapseZone(): void {
    const { incident, targetHeightM } = getAppState()
    if (!incident) return
    const radius = Math.max(20, (targetHeightM ?? 20) * 1.5)
    const R = 6371008.8
    const positions: { lat: number; lon: number }[] = []
    for (let i = 0; i < 24; i++) {
      const t = (i / 24) * 2 * Math.PI
      positions.push({
        lat: incident.lat + ((radius * Math.cos(t)) / R) * (180 / Math.PI),
        lon:
          incident.lon +
          ((radius * Math.sin(t)) / (R * Math.cos((incident.lat * Math.PI) / 180))) * (180 / Math.PI),
      })
    }
    void saveShape({
      id: `WT-ICS-ZONE-COLLAPSE-${Date.now().toString(36).toUpperCase()}`,
      kind: 'zone',
      zone: 'hot',
      positions,
      createdAt: new Date().toISOString(),
    })
    console.log(`[tools] collapse zone: r=${Math.round(radius)} m (building ${Math.round(targetHeightM ?? 0)} m × 1.5)`)
  }

  // ---------------------------- vertex editing ------------------------------

  private onLeftDown(e: Cesium.ScreenSpaceEventHandler.PositionedEvent): void {
    const picked = this.viewer.scene.pick(e.position) as { id?: Cesium.Entity } | undefined
    const entityId = picked?.id?.id
    if (typeof entityId === 'string' && entityId.startsWith('handle:')) {
      this.dragIndex = Number(entityId.split(':')[1])
      this.viewer.scene.screenSpaceCameraController.enableInputs = false
    }
  }

  private onMouseMove(e: Cesium.ScreenSpaceEventHandler.MotionEvent): void {
    if (this.dragIndex === null) return
    const state = getAppState()
    const shape = state.selectedShapeId ? state.shapes[state.selectedShapeId] : null
    if (!shape || shape.kind !== 'zone') return
    const pos = this.groundPosition(e.endPosition)
    if (!pos) return
    const positions = shape.positions.map((p, i) => (i === this.dragIndex ? { lat: pos.lat, lon: pos.lon } : p))
    const updated = { ...shape, positions }
    setAppState((s) => ({ shapes: { ...s.shapes, [shape.id]: updated } }))
    this.shapes.upsert(updated)
    this.renderHandles()
  }

  private onLeftUp(): void {
    if (this.dragIndex === null) return
    this.dragIndex = null
    this.viewer.scene.screenSpaceCameraController.enableInputs = true
    const state = getAppState()
    const shape = state.selectedShapeId ? state.shapes[state.selectedShapeId] : null
    if (shape) void saveShape(shape) // persist + re-publish CoT after the edit
  }

  // ------------------------------- rendering -------------------------------

  private renderDraft(zone: ZoneKind): void {
    this.draftSource.entities.removeAll()
    const color = Cesium.Color.fromCssColorString(ZONE_STYLE[zone].css)
    for (let i = 0; i < this.draft.length; i++) {
      this.draftSource.entities.add({
        position: Cesium.Cartesian3.fromDegrees(this.draft[i].lon, this.draft[i].lat, 0),
        point: {
          pixelSize: 8,
          color,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1.5,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
    }
    if (this.draft.length >= 2) {
      this.draftSource.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(this.draft.flatMap((p) => [p.lon, p.lat])),
          width: 3,
          material: color.withAlpha(0.9),
          clampToGround: true,
        },
      })
    }
    if (this.draft.length >= 3 && zone !== 'perimeter') {
      this.draftSource.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(this.draft.flatMap((p) => [p.lon, p.lat])),
          ),
          material: color.withAlpha(0.15),
          classificationType: Cesium.ClassificationType.BOTH,
        },
      })
    }
  }

  renderHandles(): void {
    this.handleSource.entities.removeAll()
    const state = getAppState()
    const shape = state.selectedShapeId ? state.shapes[state.selectedShapeId] : null
    if (!shape || shape.kind !== 'zone') return
    const color = Cesium.Color.fromCssColorString(ZONE_STYLE[shape.zone].css)
    shape.positions.forEach((p, i) => {
      this.handleSource.entities.add({
        id: `handle:${i}`,
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0),
        point: {
          pixelSize: 11,
          color: Cesium.Color.WHITE,
          outlineColor: color,
          outlineWidth: 3,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
    })
  }
}
