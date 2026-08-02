import { useState } from 'react'
import { useMovable } from '../lib/movable'
import { deleteSelectedShape, rotateSelectedApparatus, setDrawTool } from '../actions'
import { POST_META, ZONE_STYLE } from '../cesium/shapes'
import { setAppState, useAppSlice } from '../state/store'
import type { PostKind, ZoneKind } from '../types'

// One editable outline replaces the old HOT/WARM/COLD trio; legacy zone
// shapes still render, they just can't be drawn fresh.
const ZONES: ZoneKind[] = ['perimeter']
const POSTS: PostKind[] = ['icp', 'staging', 'triage', 'media', 'transport']

/** STGE picker: choose the next-due company or a specific responding unit. */
function StagingPicker() {
  const { units, shapes, stagingPick } = useAppSlice((s) => ({ units: s.units, shapes: s.shapes, stagingPick: s.stagingPick }))
  const reserved = new Set(
    Object.values(shapes)
      .filter((s) => s.kind === 'apparatus')
      .map((s) => (s.kind === 'apparatus' ? s.callsign : '')),
  )
  const candidates = Object.values(units)
    .filter(
      (u) =>
        u.agency === 'FDNY' &&
        ['engine', 'ladder', 'rescue', 'battalion'].includes(u.category) &&
        (!u.status || u.status === 'Enroute' || u.status === 'Staged') &&
        !reserved.has(u.callsign),
    )
    .sort((a, b) => a.callsign.localeCompare(b.callsign))
  return (
    <div className="staging-picker glass">
      <span className="picker-label">STAGE FOR:</span>
      <button
        className={`toggle-chip${stagingPick === 'auto' ? ' on' : ''}`}
        onClick={() => setAppState({ stagingPick: 'auto' })}
        title="Auto-label with the next-due company"
      >
        AUTO
      </button>
      {candidates.map((u) => (
        <button
          key={u.uid}
          className={`toggle-chip${stagingPick === u.callsign ? ' on' : ''}`}
          onClick={() => setAppState({ stagingPick: u.callsign })}
          title={`Reserve the next pad for ${u.callsign} (${u.status ?? 'responding'})`}
        >
          {u.callsign}
        </button>
      ))}
      {candidates.length === 0 && <span className="picker-note">NO UNRESERVED RESPONDING UNITS — AUTO USES NEXT-DUE</span>}
    </div>
  )
}

export function DrawToolbar() {
  const mvDrawtoolbar = useMovable('draw-toolbar')
  const { drawTool, selectedShapeId, incident, streetViewOpen, shapes } = useAppSlice((s) => ({ drawTool: s.drawTool, selectedShapeId: s.selectedShapeId, incident: s.incident, streetViewOpen: s.streetViewOpen, shapes: s.shapes }))
  const [collapsed, setCollapsed] = useState(false)
  if (!incident) return null

  const zoneActive = drawTool && (ZONES as string[]).includes(drawTool)
  const selectedShape = selectedShapeId ? shapes[selectedShapeId] : null
  const apparatusSelected = selectedShape?.kind === 'apparatus'

  if (collapsed) {
    return (
      <button className="draw-toolbar glass tools-collapsed" onClick={() => setCollapsed(false)} title="Expand ICS tools">
        TOOLS ▸
      </button>
    )
  }

  return (
    <>
      <div {...mvDrawtoolbar} className="draw-toolbar glass">
        <button className="tool-collapse" onClick={() => setCollapsed(true)} title="Minimize ICS tools">
          ◂
        </button>
        <div className="tool-section-label">PERIM</div>
        {ZONES.map((z) => (
          <button
            key={z}
            className={`tool-btn${drawTool === z ? ' on' : ''}`}
            style={{ ['--tool-color' as string]: ZONE_STYLE[z].css }}
            onClick={() => setDrawTool(z)}
            title="Draw an editable perimeter outline — click vertices, Enter or double-click to close, then drag points to adjust"
          >
            <span className="tool-swatch zone" />
            PERIM
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
        <div className="tool-section-label">CHIEF</div>
        <button
          className={`tool-btn${drawTool === 'measure' ? ' on' : ''}`}
          style={{ ['--tool-color' as string]: '#22d3ee' }}
          onClick={() => setDrawTool('measure')}
          title="Measure distance (two clicks)"
        >
          <span className="tool-swatch post" />
          MEAS
        </button>
        <button
          className={`tool-btn${drawTool === 'collapse' ? ' on' : ''}`}
          style={{ ['--tool-color' as string]: '#ef4444' }}
          onClick={() => setDrawTool('collapse')}
          title="Collapse zone: 1.5× building height around the incident building (one click)"
        >
          <span className="tool-swatch zone" />
          CLPS
        </button>
        <button
          className={`tool-btn${drawTool === 'apparatus' ? ' on' : ''}`}
          style={{ ['--tool-color' as string]: '#dc2626' }}
          onClick={() => setDrawTool('apparatus')}
          title="Staging: place truck-scale spots auto-labeled with the next incoming units (stays armed; Esc to stop)"
        >
          <span className="tool-swatch zone" />
          STGE
        </button>
        <div className="tool-section-label">VIEW</div>
        <button
          className={`tool-btn${drawTool === 'ground' ? ' on' : ''}`}
          style={{ ['--tool-color' as string]: '#22d3ee' }}
          onClick={() => setDrawTool('ground')}
          title="Ground view: click anywhere to see the scene from eye height at that spot (Esc returns)"
        >
          <span className="tool-swatch post" />
          GND
        </button>
        <button
          className={`tool-btn${streetViewOpen ? ' on' : ''}`}
          style={{ ['--tool-color' as string]: '#22d3ee' }}
          onClick={() => setAppState((s) => ({ streetViewOpen: !s.streetViewOpen }))}
          title="Photographic street view of the incident address — opens aimed at the building; drag to look around"
        >
          <span className="tool-swatch post" />
          STV
        </button>
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
            : drawTool === 'measure'
              ? 'CLICK TWO POINTS TO MEASURE · ESC CLEARS'
              : drawTool === 'collapse'
                ? 'CLICK ANYWHERE — COLLAPSE ZONE DRAWS AT 1.5× BUILDING HEIGHT'
                : drawTool === 'apparatus'
                  ? 'CLICK TO RESERVE TRUCK-SIZE STAGING SPOTS (AUTO-LABELED NEXT-DUE UNITS) · ESC TO STOP'
                  : drawTool === 'ground'
                    ? 'SET HEIGHT ON THE 0–50 FT SCALE, THEN CLICK ANY SPOT · ESC RETURNS TO TACTICAL'
                    : 'CLICK THE MAP TO PLACE · ESC TO CANCEL'}
        </div>
      )}
      {drawTool === 'apparatus' && <StagingPicker />}
      {!drawTool && selectedShapeId && apparatusSelected && (
        <div className="draw-hint glass">
          {selectedShape?.kind === 'apparatus' ? `${selectedShape.callsign} · ` : ''}DRAG PAD TO MOVE ·
          <button className="hint-btn" onClick={() => rotateSelectedApparatus(-15)} title="Rotate left ([ key)">
            ⟲
          </button>
          <button className="hint-btn" onClick={() => rotateSelectedApparatus(15)} title="Rotate right (] key)">
            ⟳
          </button>
          ROTATE · DEL REMOVES · ESC DESELECTS
        </div>
      )}
      {!drawTool && selectedShapeId && !apparatusSelected && (
        <div className="draw-hint glass">SHAPE SELECTED — DRAG VERTICES TO EDIT · DEL TO REMOVE · ESC TO DESELECT</div>
      )}
    </>
  )
}
