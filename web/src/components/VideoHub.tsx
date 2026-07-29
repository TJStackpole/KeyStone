import { useMemo, useState } from 'react'
import { flyToUnit } from '../actions'
import { getUnitLayer } from '../cesium/scene'
import { setAppState, useAppState } from '../state/store'
import { droneStreamFor } from './DronePanel'
import { VideoTile } from './VideoTile'

type VideoTab = 'uas' | 'helo' | 'bodycam'

/**
 * Unified video hub (comms-style tabs): UAS feeds bound to drones on the
 * picture, the aviation/helicopter feed, and the body-cam wall. All feeds are
 * SIMULATED and watermarked; a real RTSP source is a MediaMTX config swap.
 */
export function VideoHub() {
  const { bodycamOpen, units, selectedUnitUid } = useAppState()
  const [tab, setTab] = useState<VideoTab>('uas')

  const drones = useMemo(
    () =>
      Object.values(units)
        .filter((u) => u.category === 'drone')
        .sort((a, b) => a.callsign.localeCompare(b.callsign)),
    [units],
  )
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
        <span className="card-title">Video</span>
        <div className="video-tabs">
          {(['uas', 'helo', 'bodycam'] as VideoTab[]).map((t) => (
            <button key={t} className={`comms-tab${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}>
              {t.toUpperCase()}
            </button>
          ))}
        </div>
        <button className="panel-close" onClick={() => setAppState({ bodycamOpen: false })}>
          ✕
        </button>
      </div>

      {tab === 'uas' && (
        <div className="bodycam-grid">
          {drones.length === 0 && <div className="roster-empty">NO UAS ON THE PICTURE — DISPATCH THE ASSIGNMENT</div>}
          {drones.map((d) => (
            <VideoTile
              key={d.uid}
              stream={droneStreamFor(d.uid, drones.map((x) => x.uid))}
              label={`${d.callsign} · ${Math.round(d.hae)} m`}
              chip="FDNY UAS"
              selected={selectedUnitUid === d.uid}
              onClick={() => select(d.uid)}
            />
          ))}
        </div>
      )}

      {tab === 'helo' && (
        <div className="bodycam-grid single">
          <VideoTile stream="helo1" label="HELO-1 · AVIATION UNIT" chip="NYPD AVN" />
        </div>
      )}

      {tab === 'bodycam' && (
        <div className="bodycam-grid">
          {crews.length === 0 && <div className="roster-empty">NO FDNY UNITS ON THE PICTURE</div>}
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
      )}
    </aside>
  )
}
