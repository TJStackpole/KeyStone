import { useEffect, useMemo, useState } from 'react'
import { placeExposureLabels, toggleIsolateMode, windName } from '../actions'
import { GOOGLE_KEY, faceViews, loadMapsJs, nysOrthoFace } from './oblique'
import type { FaceView, TargetFrame } from './oblique'
import { useAppSlice } from '../state/store'
import './SizeUpStrip.css'

// ---------------------------------------------------------------------------
// Prompt 14 A2 — the SIZE-UP strip on the incident header. Replaces the 3D
// flyaround as the way an officer reads the building: OBLIQUE four-face
// views (keyless NYS ortho; Google 45° when the key exists) with the
// exposure ASSIGN control, and STREET — a live look-around panorama the
// officer can rotate to read the environment they are going into. LIVE
// VIEWS holds the ISOLATE camera rail. Nothing fetches until its tab opens.
// ---------------------------------------------------------------------------

type Tab = 'oblique' | 'street' | 'views'

type ViewLockApi = typeof import('../cesium/viewLock')

const SIDES = [
  { id: 'north' as const, label: 'N' },
  { id: 'east' as const, label: 'E' },
  { id: 'south' as const, label: 'S' },
  { id: 'west' as const, label: 'W' },
]

/** Bearing from a pano point toward the building — the panorama opens facing
 *  the front door, then the operator rotates freely. */
function bearingTo(fromLat: number, fromLon: number, toLat: number, toLon: number): number {
  const dLon = (toLon - fromLon) * Math.cos(((fromLat + toLat) / 2) * (Math.PI / 180))
  const dLat = toLat - fromLat
  return ((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360
}

export function SizeUpStrip() {
  const { incident, targetBounds, shapes, viewLock, viewLockFloor, suspended, orbitPaused, units } = useAppSlice((s) => ({
    incident: s.incident,
    targetBounds: s.targetBounds,
    shapes: s.shapes,
    viewLock: s.viewLock,
    viewLockFloor: s.viewLockFloor,
    suspended: s.viewLockSuspended,
    orbitPaused: s.viewLockOrbitPaused,
    units: s.units,
  }))
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState<Tab>('oblique')
  const [faceIdx, setFaceIdx] = useState(0)
  const [obliqueSrc, setObliqueSrc] = useState<'nys' | 'google45'>('nys')
  // Exposure assignment: the responding officer taps ASSIGN, then the face
  // that faces the street — it becomes EXPOSURE 1, 2-3-4 number clockwise
  // (placed as EXPO posts: on both maps, persisted, one undo entry).
  const [assigning, setAssigning] = useState(false)
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [streetErr, setStreetErr] = useState<string | null>(null)
  // LIVE VIEWS (the old floating battle-view rail, docked here): the camera
  // API lazy-loads with the tab so this component keeps Cesium out of its
  // static graph. The tab is always on the strip — unlocked it offers the
  // one-press ISOLATE engage (so the tool is findable), locked it holds the
  // camera controls.
  const locked = viewLock !== 'off'
  const [vl, setVl] = useState<ViewLockApi | null>(null)
  useEffect(() => {
    if (locked && !vl) void import('../cesium/viewLock').then(setVl)
  }, [locked, vl])
  useEffect(() => {
    // Lock engaging pulls the strip to the camera controls; disengaging
    // returns to imagery so a dead tab never lingers.
    setTab((t) => (locked ? 'views' : t === 'views' ? 'oblique' : t))
  }, [locked])
  // One-keystroke camera control while locked (moved from the old rail).
  useEffect(() => {
    if (!locked || !vl) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 'o') vl.setViewLockMode('orbit')
      else if (k === 't') vl.setViewLockMode('top')
      else if (k === 'n') vl.setViewLockMode('north')
      else if (k === 'e') vl.setViewLockMode('east')
      else if (k === 's') vl.setViewLockMode('south')
      else if (k === 'w') vl.setViewLockMode('west')
      else if (e.key === 'ArrowUp') {
        e.preventDefault()
        vl.stepViewLockFloor(1)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        vl.stepViewLockFloor(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [locked, vl])

  const frame: TargetFrame | null = targetBounds
  // shapes in the deps: pressing EXPO re-maps 1-4 to the REAL street side.
  const faces: FaceView[] = useMemo(() => (frame ? faceViews(frame) : []), [frame, shapes])
  const face = faces[faceIdx % 4] ?? null

  // OBLIQUE (keyless NYS path): fetch + rotate + burn, per face, tab-lazy.
  useEffect(() => {
    if (!open || tab !== 'oblique' || obliqueSrc !== 'nys' || !frame || !face) return
    let dead = false
    setFrameUrl(null)
    setErr(null)
    nysOrthoFace(frame, face)
      .then((url) => {
        if (!dead) setFrameUrl(url)
      })
      .catch(() => {
        if (!dead) setErr('IMAGERY UNAVAILABLE — NYS ortho did not answer')
      })
    return () => {
      dead = true
    }
  }, [open, tab, obliqueSrc, frame, face])

  // OBLIQUE (Google 45°): the Maps JS API loads only on first selection.
  useEffect(() => {
    if (!open || tab !== 'oblique' || obliqueSrc !== 'google45' || !frame || !face) return
    let dead = false
    setErr(null)
    loadMapsJs()
      .then(() => {
        if (dead) return
        const g = (window as unknown as { google: { maps: { Map: new (el: HTMLElement, opts: unknown) => unknown } } }).google
        const el = document.getElementById('sizeup-g45')
        if (!el) return
        new g.maps.Map(el, {
          center: { lat: frame.centerLat, lng: frame.centerLon },
          zoom: 19,
          mapTypeId: 'satellite',
          tilt: 45,
          heading: face.headingDeg,
          disableDefaultUI: true,
          gestureHandling: 'none',
          keyboardShortcuts: false,
        })
      })
      .catch(() => {
        if (!dead) setErr('GOOGLE 45° UNAVAILABLE — check the Maps JavaScript API on the key')
      })
    return () => {
      dead = true
    }
  }, [open, tab, obliqueSrc, frame, face])

  // STREET: a live, rotatable panorama — the nearest outdoor pano to the
  // building, opened FACING it. The officer drags to look around the block
  // they are going into; the pano's own arrows walk the street.
  useEffect(() => {
    if (!open || tab !== 'street' || !frame || !GOOGLE_KEY) return
    let dead = false
    setStreetErr(null)
    loadMapsJs()
      .then(() => {
        if (dead) return
        const g = (
          window as unknown as {
            google: {
              maps: {
                StreetViewService: new () => {
                  getPanorama: (
                    req: unknown,
                    cb: (data: { location?: { pano?: string; latLng?: { lat: () => number; lng: () => number } } } | null, status: string) => void,
                  ) => void
                }
                StreetViewPanorama: new (el: HTMLElement, opts: unknown) => unknown
              }
            }
          }
        ).google
        new g.maps.StreetViewService().getPanorama(
          {
            location: { lat: frame.centerLat, lng: frame.centerLon },
            radius: 90,
            preference: 'nearest',
            source: 'outdoor',
          },
          (data, status) => {
            if (dead) return
            const el = document.getElementById('sizeup-pano')
            if (!el) return
            if (status !== 'OK' || !data?.location?.pano || !data.location.latLng) {
              setStreetErr('NO STREET VIEW COVERAGE AT THIS ADDRESS')
              return
            }
            const heading = bearingTo(data.location.latLng.lat(), data.location.latLng.lng(), frame.centerLat, frame.centerLon)
            new g.maps.StreetViewPanorama(el, {
              pano: data.location.pano,
              pov: { heading, pitch: 6 },
              zoom: 0.7,
              addressControl: false,
              fullscreenControl: false,
              motionTracking: false,
              motionTrackingControl: false,
              showRoadLabels: true,
            })
          },
        )
      })
      .catch(() => {
        if (!dead) setStreetErr('STREET VIEW UNAVAILABLE — check the Maps JavaScript API on the key')
      })
    return () => {
      dead = true
    }
  }, [open, tab, frame])

  if (!incident || !frame) return null

  return (
    <div className="sizeup">
      <button className="sizeup-head" onClick={() => setOpen((v) => !v)} title="Size-up imagery — oblique faces and a look-around street view">
        SIZE-UP {open ? '▾' : '▸'}
      </button>
      {open && (
        <>
          <div className="sizeup-tabs" role="tablist">
            {(['views', 'oblique', 'street'] as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={`sizeup-tab${tab === t ? ' on' : ''}${t === 'views' && locked ? ' live' : ''}`} onClick={() => setTab(t)}>
                {t === 'views' ? 'LIVE VIEWS' : t === 'oblique' ? 'OBLIQUE' : 'STREET'}
              </button>
            ))}
          </div>

          {tab === 'oblique' && (
            <div className="sizeup-faces">
              {faces.map((f, i) => (
                <button
                  key={f.exposure}
                  className={`sizeup-face${!assigning && i === faceIdx ? ' on' : ''}${assigning ? ' pick' : ''}`}
                  title={
                    assigning
                      ? `Make the ${windName(f.headingDeg)} face EXPOSURE 1 — 2-3-4 number clockwise from it`
                      : `Exposure ${f.exposure} — the ${windName(f.headingDeg)} face, viewed from off that side toward the building`
                  }
                  onClick={() => {
                    if (!assigning) {
                      setFaceIdx(i)
                      return
                    }
                    setAssigning(false)
                    setFaceIdx(0) // EXP 1 = the face just designated
                    void placeExposureLabels(f.headingDeg)
                  }}
                >
                  {assigning ? `${windName(f.headingDeg)} → 1` : `EXP ${f.exposure}·${windName(f.headingDeg)}`}
                </button>
              ))}
              <button
                className={`sizeup-face assign${assigning ? ' on' : ''}`}
                title="Assign exposures: tap this, then tap the face that faces the street — it becomes EXPOSURE 1 and 2-3-4 number clockwise. Places the EXP markers on the map (one undo entry)."
                onClick={() => setAssigning((v) => !v)}
              >
                {assigning ? '✕ CANCEL' : '⚑ ASSIGN'}
              </button>
              {GOOGLE_KEY && (
                <button
                  className={`sizeup-face src${obliqueSrc === 'google45' ? ' on' : ''}`}
                  onClick={() => setObliqueSrc((v) => (v === 'nys' ? 'google45' : 'nys'))}
                  title="Swap oblique source: NYS ortho (keyless) ↔ Google 45° aerial"
                >
                  {obliqueSrc === 'nys' ? 'G-45°' : 'NYS'}
                </button>
              )}
            </div>
          )}
          {assigning && tab === 'oblique' && (
            <div className="sizeup-assign-hint">TAP THE STREET-SIDE FACE — IT BECOMES EXP 1 · 2-3-4 CLOCKWISE</div>
          )}

          {tab === 'views' && !locked && (
            <div className="sizeup-views">
              <button
                className="bv-lock"
                onClick={toggleIsolateMode}
                title="Engage ISOLATE: clips to the fire building and locks the camera to disciplined views — TOP + head-on N/E/S/W facades with floor-by-floor stepping"
              >
                🔒 LOCK STRUCTURE VIEWS — ISOLATE
              </button>
              <div className="sizeup-views-hints">
                Locks the camera to the fire building: TOP + N·E·S·W head-on facades, floor stepping, fire-floor jump. Same switch as ISOLATE in the top bar; the 🔓 button or ISOLATE OFF releases it.
              </div>
            </div>
          )}
          {tab === 'views' && locked && (
            <div className="sizeup-views">
              {viewLock === 'orbit' ? (
                <button
                  className={`bv-lock${orbitPaused ? ' free' : ''}`}
                  onClick={() => vl?.setOrbitPaused(!orbitPaused)}
                  title={orbitPaused ? 'Orbit paused — press to resume the lap' : 'Slow lap around the structure — press to pause and look'}
                >
                  {orbitPaused ? '▶ RESUME ORBIT' : '⏸ PAUSE ORBIT'}
                </button>
              ) : (
                <button
                  className={`bv-lock${suspended ? ' free' : ''}`}
                  onClick={() => vl?.setViewLockSuspended(!suspended)}
                  title={suspended ? 'Camera is FREE — click to lock back into the disciplined view' : 'Camera is LOCKED to disciplined views — click to move around freely'}
                >
                  {suspended ? '🔓 FREE' : '🔒 LOCKED'}
                </button>
              )}
              <div className="sizeup-views-row">
                <button className={`bv-btn${viewLock === 'orbit' ? ' on' : ''}`} onClick={() => vl?.setViewLockMode('orbit')} title="Auto-rotating lap around the structure (O)">
                  ⟳
                </button>
                <button className={`bv-btn${viewLock === 'top' ? ' on' : ''}`} onClick={() => vl?.setViewLockMode('top')} title="Straight-down command view, north up (T)">
                  TOP
                </button>
                {SIDES.map((sd) => (
                  <button key={sd.id} className={`bv-btn${viewLock === sd.id ? ' on' : ''}`} onClick={() => vl?.setViewLockMode(sd.id)} title={`Head-on ${sd.id.toUpperCase()} facade — enters at street level, ↑↓ climbs the floors`}>
                    {sd.label}
                  </button>
                ))}
              </div>
              {vl && viewLock !== 'orbit' && (
                <div className="sizeup-views-floor">
                  <button className="bv-btn" disabled={viewLockFloor <= 1} onClick={() => vl.stepViewLockFloor(-1)} title="Floor down (↓)">
                    ▼
                  </button>
                  <div className="bv-floor-readout">
                    <b>
                      {viewLock === 'top' ? 'PLAN ' : ''}FL {viewLockFloor}
                    </b>
                    <i>
                      {(() => {
                        const onFloor = Object.values(units).filter(
                          (u) => (u.category === 'ff' || u.category === 'officer') && (u.floor ?? 0) === viewLockFloor,
                        ).length
                        return `${onFloor > 0 ? `${onFloor} MBR` : '—'} · ${vl.viewLockFloors()} FL`
                      })()}
                    </i>
                  </div>
                  <button className="bv-btn" disabled={viewLockFloor >= vl.viewLockFloors()} onClick={() => vl.stepViewLockFloor(1)} title="Floor up (↑)">
                    ▲
                  </button>
                  {vl.battleFireFloor() !== null && vl.battleFireFloor() !== viewLockFloor && (
                    <button className="bv-btn bv-fire" onClick={() => vl.jumpViewLockFloor(vl.battleFireFloor()!)} title="Jump to the fire floor">
                      ◎ FL {vl.battleFireFloor()}
                    </button>
                  )}
                </div>
              )}
              <div className="sizeup-views-hints">{viewLock === 'orbit' ? 'AUTO-ORBITING (ZOOM LOCKED) · ⏸ TO PAUSE · N/E/S/W ENTER AT STREET LEVEL' : 'O orbit · T·N·E·S·W keys · ↑↓ floors · scroll zooms'}</div>
            </div>
          )}
          <div className="sizeup-media" style={tab === 'views' ? { display: 'none' } : undefined}>
            {tab === 'oblique' && obliqueSrc === 'nys' && (frameUrl ? <img src={frameUrl} alt={`Exposure ${face?.exposure}`} /> : <div className="sizeup-wait">{err ?? 'FETCHING NYS IMAGERY…'}</div>)}
            {tab === 'oblique' && obliqueSrc === 'google45' && (
              <div id="sizeup-g45" className="sizeup-g45">
                {err && <div className="sizeup-wait">{err}</div>}
              </div>
            )}
            {tab === 'street' &&
              (GOOGLE_KEY ? (
                <div id="sizeup-pano" className="sizeup-pano">
                  {streetErr && <div className="sizeup-wait">{streetErr}</div>}
                </div>
              ) : (
                <div className="sizeup-wait">STREET VIEW NEEDS THE GOOGLE KEY IN .env (GOOGLE_MAPS_API_KEY)</div>
              ))}
          </div>
          {tab === 'street' && GOOGLE_KEY && !streetErr && (
            <div className="sizeup-views-hints">DRAG TO LOOK AROUND · ARROWS WALK THE STREET · OPENS FACING THE BUILDING</div>
          )}
        </>
      )}
    </div>
  )
}
