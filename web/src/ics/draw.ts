import * as Cesium from 'cesium'
import { deleteShape, saveShape } from '../actions'
import { ShapeLayer, ZONE_STYLE } from '../cesium/shapes'
import { getAppState, setAppState } from '../state/store'
import type { IcsShape, PostKind, ZoneKind } from '../types'

const ZONES: ZoneKind[] = ['hot', 'warm', 'cold']
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
  private draftSource = new Cesium.CustomDataSource('draw-draft')
  private handleSource = new Cesium.CustomDataSource('draw-handles')
  private dragIndex: number | null = null
  private keyListener = (e: KeyboardEvent) => this.onKey(e)

  constructor(private viewer: Cesium.Viewer, private shapes: ShapeLayer) {
    void viewer.dataSources.add(this.draftSource)
    void viewer.dataSources.add(this.handleSource)
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

  private groundPosition(screen: Cesium.Cartesian2): { lat: number; lon: number } | null {
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
    return { lat: Cesium.Math.toDegrees(carto.latitude), lon: Cesium.Math.toDegrees(carto.longitude) }
  }

  // ----------------------------- interactions ------------------------------

  private onLeftClick(e: Cesium.ScreenSpaceEventHandler.PositionedEvent): void {
    if (this.dragIndex !== null) return
    const tool = getAppState().drawTool
    const pos = this.groundPosition(e.position)
    if (!pos) return

    if (tool && ZONES.includes(tool as ZoneKind)) {
      this.draft.push(pos)
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

    // No tool: select/deselect shapes.
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
    if (typeof entityId !== 'string' || !entityId.startsWith('handle:')) {
      setAppState({ selectedShapeId: null })
      this.renderHandles()
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
    this.draftSource.entities.removeAll()
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
    const positions = shape.positions.map((p, i) => (i === this.dragIndex ? pos : p))
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
        position: Cesium.Cartesian3.fromDegrees(this.draft[i].lon, this.draft[i].lat, 1),
        point: { pixelSize: 8, color, outlineColor: Cesium.Color.BLACK, outlineWidth: 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY },
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
    if (this.draft.length >= 3) {
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
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 1),
        point: {
          pixelSize: 11,
          color: Cesium.Color.WHITE,
          outlineColor: color,
          outlineWidth: 3,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
    })
  }
}
