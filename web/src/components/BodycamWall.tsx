import { useMemo } from 'react'
import { flyToUnit } from '../actions'
import { getUnitLayer } from '../cesium/scene'
import { setAppState, useAppState } from '../state/store'
import { VideoTile } from './VideoTile'

/**
 * 2x2 body-cam wall: each tile bound to an on-scene FDNY ground unit, backed by
 * the looped MediaMTX bodycam streams. Tile click <-> globe marker highlight.
 */
export function BodycamWall() {
  const { bodycamOpen, units, selectedUnitUid } = useAppState()

  const crews = useMemo(
    () =>
      Object.values(units)
        .filter((u) => u.agency === 'FDNY' && u.category !== 'drone')
        .sort((a, b) => a.callsign.localeCompare(b.callsign))
        .slice(0, 4),
    [units],
  )

  if (!bodycamOpen) return null

  const select = (uid: string) => {
    const next = selectedUnitUid === uid ? null : uid
    setAppState({ selectedUnitUid: next })
    getUnitLayer()?.setSelected(next)
    if (next) flyToUnit(next)
  }

  return (
    <aside className="bodycam-wall glass">
      <div className="panel-head">
        <span className="card-title">Body-Cam Wall</span>
        <button className="panel-close" onClick={() => setAppState({ bodycamOpen: false })}>
          ✕
        </button>
      </div>
      {crews.length === 0 && <div className="roster-empty">NO FDNY UNITS ON THE PICTURE</div>}
      <div className="bodycam-grid">
        {crews.map((u, i) => (
          <VideoTile
            key={u.uid}
            stream={`bodycam${(i % 2) + 1}`}
            label={u.callsign}
            chip={u.agency}
            selected={selectedUnitUid === u.uid}
            onClick={() => select(u.uid)}
          />
        ))}
      </div>
    </aside>
  )
}
