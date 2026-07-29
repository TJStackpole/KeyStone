import { deleteSelectedShape, setDrawTool } from '../actions'
import { POST_META, ZONE_STYLE } from '../cesium/shapes'
import { useAppState } from '../state/store'
import type { PostKind, ZoneKind } from '../types'

const ZONES: ZoneKind[] = ['hot', 'warm', 'cold']
const POSTS: PostKind[] = ['icp', 'staging', 'triage', 'media', 'transport']

export function DrawToolbar() {
  const { drawTool, selectedShapeId, incident } = useAppState()
  if (!incident) return null

  const zoneActive = drawTool && (ZONES as string[]).includes(drawTool)

  return (
    <>
      <div className="draw-toolbar glass">
        <div className="tool-section-label">ZONES</div>
        {ZONES.map((z) => (
          <button
            key={z}
            className={`tool-btn${drawTool === z ? ' on' : ''}`}
            style={{ ['--tool-color' as string]: ZONE_STYLE[z].css }}
            onClick={() => setDrawTool(z)}
            title={`Draw ${ZONE_STYLE[z].label} polygon`}
          >
            <span className="tool-swatch zone" />
            {z.toUpperCase()}
          </button>
        ))}
        <div className="tool-section-label">POSTS</div>
        {POSTS.map((p) => (
          <button
            key={p}
            className={`tool-btn${drawTool === p ? ' on' : ''}`}
            style={{ ['--tool-color' as string]: POST_META[p].css }}
            onClick={() => setDrawTool(p)}
            title={`Place ${POST_META[p].label}`}
          >
            <span className="tool-swatch post" />
            {POST_META[p].glyph}
          </button>
        ))}
        <div className="tool-divider" />
        <button
          className="tool-btn danger"
          disabled={!selectedShapeId}
          onClick={deleteSelectedShape}
          title="Delete selected shape (Del)"
        >
          ✕ DEL
        </button>
      </div>
      {drawTool && (
        <div className="draw-hint glass">
          {zoneActive
            ? 'CLICK VERTICES · ENTER OR DOUBLE-CLICK TO CLOSE · ESC TO CANCEL'
            : 'CLICK THE MAP TO PLACE · ESC TO CANCEL'}
        </div>
      )}
      {!drawTool && selectedShapeId && (
        <div className="draw-hint glass">SHAPE SELECTED — DRAG VERTICES TO EDIT · DEL TO REMOVE · ESC TO DESELECT</div>
      )}
    </>
  )
}
