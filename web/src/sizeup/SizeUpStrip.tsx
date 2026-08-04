import { useEffect, useMemo, useState } from 'react'
import { MiniModel } from './MiniModel'
import { GOOGLE_KEY, faceViews, loadMapsJs, nysOrthoFace } from './oblique'
import type { FaceView, TargetFrame } from './oblique'
import { streetShot } from './streetview'
import type { StreetShot } from './streetview'
import { useAppSlice } from '../state/store'
import './SizeUpStrip.css'

// ---------------------------------------------------------------------------
// Prompt 14 A2 — the SIZE-UP strip on the incident header. Replaces the 3D
// flyaround as the way an officer reads the building: OBLIQUE four-face
// views (keyless NYS ortho; Google 45° when the key exists), STREET at each
// exposure with capture dates, and the on-demand rotatable MODEL. Nothing
// fetches until its tab is opened; imagery vintage rides on every frame.
// ---------------------------------------------------------------------------

type Tab = 'oblique' | 'street' | 'model'

export function SizeUpStrip() {
  const { incident, targetBounds, footprintsGeo } = useAppSlice((s) => ({
    incident: s.incident,
    targetBounds: s.targetBounds,
    footprintsGeo: s.footprintsGeo,
  }))
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState<Tab>('oblique')
  const [faceIdx, setFaceIdx] = useState(0)
  const [obliqueSrc, setObliqueSrc] = useState<'nys' | 'google45'>('nys')
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [street, setStreet] = useState<StreetShot | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const frame: TargetFrame | null = targetBounds
  const faces: FaceView[] = useMemo(() => (frame ? faceViews(frame) : []), [frame])
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

  // STREET: static image + capture date, per face, tab-lazy.
  useEffect(() => {
    if (!open || tab !== 'street' || !frame || !face) return
    let dead = false
    setStreet(null)
    void streetShot(frame, face).then((s) => {
      if (!dead) setStreet(s)
    })
    return () => {
      dead = true
    }
  }, [open, tab, frame, face])

  if (!incident || !frame) return null

  const target = footprintsGeo?.feats.find((f) => f.bin === footprintsGeo.targetBin) ?? null

  return (
    <div className="sizeup">
      <button className="sizeup-head" onClick={() => setOpen((v) => !v)} title="Size-up imagery — oblique faces, street view, rotatable model">
        SIZE-UP {open ? '▾' : '▸'}
      </button>
      {open && (
        <>
          <div className="sizeup-tabs" role="tablist">
            {(['oblique', 'street', 'model'] as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={`sizeup-tab${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}>
                {t === 'oblique' ? 'OBLIQUE' : t === 'street' ? 'STREET' : '3D MODEL'}
              </button>
            ))}
          </div>

          {tab !== 'model' && (
            <div className="sizeup-faces">
              {faces.map((f, i) => (
                <button key={f.exposure} className={`sizeup-face${i === faceIdx ? ' on' : ''}`} onClick={() => setFaceIdx(i)}>
                  EXP {f.exposure}
                </button>
              ))}
              {tab === 'oblique' && GOOGLE_KEY && (
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

          <div className="sizeup-media">
            {tab === 'oblique' && obliqueSrc === 'nys' && (frameUrl ? <img src={frameUrl} alt={`Exposure ${face?.exposure}`} /> : <div className="sizeup-wait">{err ?? 'FETCHING NYS IMAGERY…'}</div>)}
            {tab === 'oblique' && obliqueSrc === 'google45' && (
              <div id="sizeup-g45" className="sizeup-g45">
                {err && <div className="sizeup-wait">{err}</div>}
              </div>
            )}
            {tab === 'street' &&
              (GOOGLE_KEY ? (
                street === null ? (
                  <div className="sizeup-wait">FETCHING STREET VIEW…</div>
                ) : street.url ? (
                  <figure className="sizeup-street">
                    <img src={street.url} alt={`Street view, exposure ${street.exposure}`} />
                    <figcaption>
                      EXPOSURE {street.exposure} · CAPTURED {street.captureDate ?? 'DATE UNKNOWN'}
                    </figcaption>
                  </figure>
                ) : (
                  <div className="sizeup-wait">NO STREET VIEW COVERAGE ON THIS SIDE</div>
                )
              ) : (
                <div className="sizeup-wait">STREET VIEW NEEDS THE GOOGLE KEY IN .env (GOOGLE_MAPS_API_KEY)</div>
              ))}
            {tab === 'model' &&
              (target ? <MiniModel target={target} centerLat={frame.centerLat} centerLon={frame.centerLon} /> : <div className="sizeup-wait">FOOTPRINT STILL LOADING…</div>)}
          </div>
        </>
      )}
    </div>
  )
}
