import { useMemo } from 'react'
import { flyToUnit } from '../actions'
import { getUnitLayer } from '../cesium/scene'
import { setAppState, useAppState } from '../state/store'
import { bioStatusOf, type BioStatus, type Unit } from '../types'
import { droneStreamFor } from './DronePanel'
import { SitrepContent } from './SitrepPanel'
import { VideoTile } from './VideoTile'

// ---------------------------------------------------------------------------
// Right utility dock — one panel, three tabs (SITREP / VIDEO / BIO), so the
// right side of the screen can never overlap itself.
// ---------------------------------------------------------------------------

const TABS = [
  { id: 'sitrep', label: 'SITREP' },
  { id: 'video', label: 'VIDEO' },
  { id: 'bio', label: 'BIO' },
] as const

export function UtilityDock() {
  const { utilityTab } = useAppState()
  if (!utilityTab) return null

  return (
    <aside className="utility-dock glass">
      <div className="panel-head">
        <div className="video-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`comms-tab${utilityTab === t.id ? ' on' : ''}`}
              onClick={() => setAppState({ utilityTab: t.id })}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button className="panel-close" onClick={() => setAppState({ utilityTab: null })}>
          ✕
        </button>
      </div>
      {utilityTab === 'sitrep' && <SitrepContent />}
      {utilityTab === 'video' && <VideoContent />}
      {utilityTab === 'bio' && <BioContent />}
    </aside>
  )
}

// ------------------------------- VIDEO tab ----------------------------------

function VideoContent() {
  const { units, selectedUnitUid } = useAppState()
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
        .filter((u) => u.agency === 'FDNY' && u.category !== 'drone' && u.category !== 'ff')
        .sort((a, b) => a.callsign.localeCompare(b.callsign))
        .slice(0, 4),
    [units],
  )

  const select = (uid: string) => {
    const next = selectedUnitUid === uid ? null : uid
    setAppState({ selectedUnitUid: next })
    getUnitLayer()?.setSelected(next)
    if (next) flyToUnit(next)
  }

  return (
    <div className="dock-scroll">
      <div className="intel-section-title">UAS · ON THE PICTURE</div>
      <div className="bodycam-grid">
        {drones.length === 0 && <div className="roster-empty">NO UAS ALOFT — DISPATCH THE ASSIGNMENT</div>}
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
      <div className="intel-section-title">AVIATION</div>
      <div className="bodycam-grid single">
        <VideoTile stream="helo1" label="HELO-1 · AVIATION UNIT" chip="NYPD AVN" />
      </div>
      <div className="intel-section-title">BODY-CAM · FIRST-DUE CREWS</div>
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
    </div>
  )
}

// -------------------------------- BIO tab -----------------------------------

const STATUS_ORDER: Record<BioStatus, number> = { rotate: 0, caution: 1, ok: 2 }

function Bar({ frac, tone }: { frac: number; tone: BioStatus }) {
  return (
    <span className={`bio-bar ${tone}`}>
      <i style={{ width: `${Math.round(Math.min(1, Math.max(0, frac)) * 100)}%` }} />
    </span>
  )
}

function BioContent() {
  const { units } = useAppState()
  const members = useMemo(() => {
    const list = Object.values(units).filter(
      (u): u is Unit & { bio: NonNullable<Unit['bio']> } =>
        !!u.bio && (u.category === 'ff' || u.category === 'officer' || u.category === 'medic'),
    )
    return list.sort(
      (a, b) => STATUS_ORDER[bioStatusOf(a.bio)] - STATUS_ORDER[bioStatusOf(b.bio)] || b.bio.hr - a.bio.hr,
    )
  }, [units])

  // Members already relieved (Rehab) shouldn't keep tripping the advisory.
  const inRehab = (m: Unit) => m.status === 'Rehab'
  const rotate = members.filter((m) => bioStatusOf(m.bio) === 'rotate' && !inRehab(m))
  const caution = members.filter((m) => bioStatusOf(m.bio) === 'caution' && !inRehab(m))

  return (
    <div className="dock-scroll">
      <div className="bio-summary">
        <span className={`status-chip ${rotate.length ? 'operating' : 'unknown'}`}>{rotate.length} ROTATE</span>
        <span className={`status-chip ${caution.length ? 'enroute' : 'unknown'}`}>{caution.length} CAUTION</span>
        <span className="status-chip onscene">{members.length - rotate.length - caution.length} OK</span>
      </div>
      {rotate.length > 0 && (
        <div className="bio-advisory">
          ⚠ ROTATION ADVISED: {rotate.map((m) => m.callsign).join(', ')} — relieve and send to rehab.
        </div>
      )}
      {members.length === 0 && (
        <div className="roster-empty">NO MEMBER TELEMETRY — PERSONNEL DISMOUNT WHEN APPARATUS ARRIVES</div>
      )}
      {members.map((m) => {
        const s = inRehab(m) ? 'ok' : bioStatusOf(m.bio)
        const chipLabel = inRehab(m) ? 'REHAB' : s.toUpperCase()
        return (
          <button key={m.uid} className={`bio-row ${s}`} onClick={() => flyToUnit(m.uid)} title="Fly to member">
            <span className="bio-callsign">{m.callsign}</span>
            <span className="bio-cell">
              <label>HR</label>
              <b>{Math.round(m.bio.hr)}</b>
              <Bar frac={m.bio.hr / 200} tone={s} />
            </span>
            <span className="bio-cell">
              <label>AIR</label>
              <b>{m.bio.airPsi < 0 ? '—' : Math.round(m.bio.airPsi)}</b>
              {m.bio.airPsi >= 0 && <Bar frac={m.bio.airPsi / 4500} tone={s} />}
            </span>
            <span className="bio-cell">
              <label>TEMP</label>
              <b>{m.bio.tempC.toFixed(1)}°</b>
            </span>
            <span className="bio-cell">
              <label>T-OPS</label>
              <b>{Math.round(m.bio.toaMin)}m</b>
            </span>
            <span
              className={`status-chip ${
                inRehab(m) ? 'staged' : s === 'rotate' ? 'operating' : s === 'caution' ? 'enroute' : 'onscene'
              }`}
            >
              {chipLabel}
            </span>
          </button>
        )
      })}
      <div className="bio-footnote">SIMULATED TELEMETRY — thresholds: HR ≥178, SCBA ≤1100 psi, core ≥38.5°C, ops ≥22 min</div>
    </div>
  )
}
