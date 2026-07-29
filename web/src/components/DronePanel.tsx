import { useMemo } from 'react'
import { setAppState, useAppState } from '../state/store'
import { VideoTile } from './VideoTile'

/** Deterministic drone -> stream mapping: drones sorted by callsign get drone1, drone2, … */
export function droneStreamFor(uid: string, droneUids: string[]): string {
  const idx = Math.max(0, droneUids.indexOf(uid))
  return `drone${(idx % 2) + 1}`
}

export function DronePanel() {
  const { dronePanelUid, units } = useAppState()
  const droneUids = useMemo(
    () =>
      Object.values(units)
        .filter((u) => u.category === 'drone')
        .sort((a, b) => a.callsign.localeCompare(b.callsign))
        .map((u) => u.uid),
    [units],
  )
  if (!dronePanelUid) return null
  const unit = units[dronePanelUid]
  if (!unit) return null

  return (
    <div className="drone-panel glass">
      <div className="panel-head">
        <span className="card-title">UAS FEED</span>
        <span className="drone-meta">
          {unit.callsign} · {Math.round(unit.hae)} m AGL
        </span>
        <button className="panel-close" onClick={() => setAppState({ dronePanelUid: null })}>
          ✕
        </button>
      </div>
      <VideoTile stream={droneStreamFor(unit.uid, droneUids)} label={unit.callsign} chip="FDNY UAS" />
    </div>
  )
}
