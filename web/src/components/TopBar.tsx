import { useEffect, useMemo, useRef, useState } from 'react'
import {
  activateInspectedIncident,
  changeEocLevel,
  enterWatchCommand,
  exitWatchCommand,
  focusFeedIncident,
  launchDualScreenDemo,
  loadScenario,
  setProfile,
  runDemoScenario,
  setIsolateScale,
  setIsolateView,
  toggleActiveIncidentMode,
  toggleIsolateMode,
  toggleLayer,
  toggleTopDownView,
} from '../actions'
import { setAppState, useAppSlice } from '../state/store'
import type { FeedIncident, ToggleLayerId } from '../types'
import { resetPanelLayout } from '../lib/movable'
import { hasCapability, PROFILES, PROFILE_SWITCHABLE, useCapability, useProfile } from '../profiles/manifest'
import { SearchBar } from './SearchBar'
import { requestElapsed } from './WatchCommandPanel'

// Map overlays that live in the top-bar OVERLAYS dropdown rather than the
// (incident-gated) Site Intel chip row — they're useful with no incident up.
const OVERLAYS: { id: ToggleLayerId; label: string; hint: string }[] = [
  { id: 'battalions', label: 'FDNY Battalions', hint: 'Battalion boundary lines' },
  { id: 'divisions', label: 'FDNY Divisions', hint: 'Division boundary lines' },
  { id: 'lots', label: 'Address grid', hint: 'Tax-lot borders — click inside one to load its address' },
  { id: 'roads', label: 'Road network', hint: 'Yellow overlay of every drivable street, highway, bridge, and ramp' },
  { id: 'tunnels', label: 'Tunnels', hint: 'Major vehicular tunnels — Lincoln, Holland, Queens-Midtown, Hugh L. Carey (commercial access varies per tunnel)' },
  { id: 'poiFirehouses', label: 'All firehouses', hint: 'Every FDNY firehouse citywide (Facilities DB)' },
  { id: 'poiFdny', label: 'FDNY buildings', hint: 'Official FDNY buildings — HQ, offices, training, EMS stations' },
  { id: 'poiPrecincts', label: 'NYPD precincts', hint: 'Precinct station houses citywide' },
  { id: 'poiHospitals', label: 'Major hospitals', hint: 'Hospitals and acute-care hospitals citywide' },
  { id: 'poiNycem', label: 'NYCEM HQ', hint: 'NYC Emergency Management headquarters and offices' },
]

function OverlaysMenu() {
  const { layerToggles } = useAppSlice((s) => ({ layerToggles: s.layerToggles }))
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const anyOn = OVERLAYS.some((o) => layerToggles[o.id])
  return (
    <div className="overlays-wrap" ref={wrapRef}>
      <button
        className={`chip chip-btn${anyOn ? ' active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Map overlays — battalion/division boundaries and the address grid"
      >
        <span className="dot" /> OVERLAYS {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="overlays-menu glass">
          {OVERLAYS.map((o) => (
            <label key={o.id} className="overlay-row" title={o.hint}>
              <input type="checkbox" checked={layerToggles[o.id]} onChange={() => toggleLayer(o.id)} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

const MODE_LABEL: Record<string, string> = {
  keyless: 'KEYLESS 3D',
  ion: 'ION TERRAIN',
  google: 'GOOGLE 3D',
}

function feedElapsed(startedAt: string): string {
  const min = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 60_000))
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60}m`
}

/**
 * Citywide INCIDENTS dropdown (next to the wordmark): the SIMULATED dispatch
 * feed from the FDNY / NYPD / PAPD dispatch centers, broken down by FDNY
 * division → battalion. Clicking a box focuses the whole board on it —
 * stand-up at its location plus the responding assignment.
 */
function IncidentsMenu() {
  const { dispatchFeed, focusedFeedId } = useAppSlice((s) => ({ dispatchFeed: s.dispatchFeed, focusedFeedId: s.focusedFeedId }))
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  // Division -> Battalion -> incidents, all numerically ordered. Built only
  // while the dropdown is open — closed, this ran on every feed update.
  const divisions = useMemo(() => {
    if (!open) return []
    const byDivision = new Map<number, Map<number, FeedIncident[]>>()
    for (const fi of dispatchFeed) {
      if (!byDivision.has(fi.division)) byDivision.set(fi.division, new Map())
      const byBn = byDivision.get(fi.division)!
      if (!byBn.has(fi.battalion)) byBn.set(fi.battalion, [])
      byBn.get(fi.battalion)!.push(fi)
    }
    return [...byDivision.entries()].sort((a, b) => a[0] - b[0])
  }, [open, dispatchFeed])

  const pick = (fi: FeedIncident) => {
    setOpen(false)
    void focusFeedIncident(fi)
  }

  return (
    <div className="incidents-wrap" ref={wrapRef}>
      <button
        className={`chip chip-btn amber${focusedFeedId ? ' active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Citywide incidents from the FDNY / NYPD / PAPD dispatch centers (SIMULATED) — click one to focus the board on it"
      >
        <span className="dot" /> INCIDENTS {dispatchFeed.length} {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="incidents-menu glass">
          <div className="incidents-head">
            SIMULATED CITYWIDE DISPATCH FEED · FDNY / NYPD / PAPD DISPATCH CENTERS
          </div>
          {divisions.length === 0 && <div className="incidents-empty">AWAITING DISPATCH FEED…</div>}
          {divisions.map(([division, byBn]) => (
            <div key={division} className="feed-division">
              <div className="feed-division-head">DIVISION {division}</div>
              {[...byBn.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([battalion, list]) => (
                  <div key={battalion} className="feed-battalion">
                    <div className="feed-battalion-head">BATTALION {battalion}</div>
                    {list.map((fi) => (
                      <button
                        key={fi.id}
                        className={`feed-row${focusedFeedId === fi.id ? ' focused' : ''}`}
                        onClick={() => pick(fi)}
                        title={`Focus the board on this box — flies to ${fi.address} and puts its responding units on the picture`}
                      >
                        <span className={`feed-src ${fi.source.toLowerCase()}`}>{fi.source}</span>
                        <span className="feed-main">
                          <b>{fi.type}</b>
                          <i>{fi.address} · {fi.borough}</i>
                        </span>
                        <span className="feed-meta">
                          {fi.units} UNITS · {feedElapsed(fi.startedAt)}
                          <em>{focusedFeedId === fi.id ? 'FOCUSED' : fi.status.toUpperCase()}</em>
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')
  return (
    <span className="clock">
      <b>
        {hh}:{mm}:{ss}
      </b>{' '}
      LOCAL
    </span>
  )
}

/** DEMO + DRILL combined — one launcher, two scripted scenarios. */
function ScenariosMenu() {
  const canExercise = useCapability('aar.hseep-exercise')
  const { scenario, incident } = useAppSlice((s) => ({ scenario: s.scenario, incident: s.incident }))
  const [open, setOpen] = useState(false)
  // One stray click must never erase a 30-minute live run: when a scenario
  // (or incident, for DEMO) is up, every launch item arms a two-step confirm.
  const [armedId, setArmedId] = useState<string | null>(null)
  const launch = (id: string, run: () => void) => {
    const destructive = id === 'demo' ? !!incident || !!scenario?.loaded : !!scenario?.loaded
    if (destructive && armedId !== id) {
      setArmedId(id)
      setTimeout(() => setArmedId((a) => (a === id ? null : a)), 3000)
      return
    }
    setArmedId(null)
    setOpen(false)
    run()
  }
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])
  return (
    <div className="scenarios-wrap" ref={wrapRef}>
      <button className="demo-btn" onClick={() => setOpen((o) => !o)} title="Scripted scenarios — demo and drill">
        ▶ SCENARIOS {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="scenarios-menu glass">
          <button className="scenario-item" onClick={() => launch('demo', () => void runDemoScenario())}>
            <b>{armedId === 'demo' ? 'REPLACES THE CURRENT BOARD — CLICK AGAIN' : 'DEMO'}</b>
            <i>Structural fire, 100 Gold St — full flow, plays unattended</i>
          </button>
          <button className="scenario-item drill" onClick={() => launch('drill', () => void loadScenario('pabt-drill'))}>
            <b>{armedId === 'drill' ? 'RESTARTS THE RUNNING DRILL — CLICK AGAIN' : (
              <>DRILL{scenario?.loaded && <em className="scn-running-chip">RUNNING</em>}</>
            )}</b>
            <i>Multi-agency bus fire w/ MCI at the Port Authority Bus Terminal</i>
          </button>
          {canExercise && (
            <button
              className="scenario-item drill"
              onClick={() => launch('exercise', () => void loadScenario('pabt-flood-exercise', { exercise: true }))}
            >
              <b>{armedId === 'exercise' ? 'RESTARTS THE RUNNING RUN — CLICK AGAIN' : 'EXERCISE'}</b>
              <i>PABT drill + Queens flash flood, two incidents — live participants, HSEEP AAR at the end</i>
            </button>
          )}
          <button className="scenario-item" onClick={() => launch('dual', () => void launchDualScreenDemo())}>
            <b>{armedId === 'dual' ? 'RESTARTS THE RUNNING RUN — CLICK AGAIN' : 'DUAL-SCREEN DEMO'}</b>
            <i>FDNY tactical here + NYCEM Watch Command in a second window, one live clock · first run: allow pop-ups, drag the new window to screen 2</i>
          </button>
        </div>
      )}
    </div>
  )
}

/** EOC activation level chip (Prompt 11): Level 4 Watch Command is the
 *  always-on default; every change requires "changed by" and logs. */
function EocChip() {
  const { eoc } = useAppSlice((s) => ({ eoc: s.eoc }))
  const [open, setOpen] = useState(false)
  const [by, setBy] = useState(() => localStorage.getItem('ks-operator') ?? '')
  const [failed, setFailed] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  // Re-sync from the shared operator identity on every open — both this chip
  // and the Watch Command panel persist every edit to ks-operator, so the
  // stored value is always the latest handoff. A fill-only-when-empty guard
  // would keep logging EOC changes under the PREVIOUS operator's name.
  useEffect(() => {
    if (open) setBy(localStorage.getItem('ks-operator') ?? '')
  }, [open])
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])
  const LABELS: Record<number, string> = {
    4: 'Level 4 — Watch Command (steady state)',
    3: 'Level 3 — Situation Room',
    2: 'Level 2 — Partial EOC',
    1: 'Level 1 — Full EOC',
  }
  return (
    <div className="eoc-wrap" ref={wrapRef}>
      <button
        className={`chip chip-btn${eoc.level < 4 ? ' amber active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={`EOC activation: ${LABELS[eoc.level]} — every change logs with "changed by"`}
      >
        <span className="dot" /> EOC L{eoc.level} {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="eoc-menu glass">
          <input
            placeholder='"Changed by" (required)'
            value={by}
            onChange={(e) => {
              setBy(e.target.value)
              localStorage.setItem('ks-operator', e.target.value)
            }}
          />
          {[4, 3, 2, 1].map((l) => (
            <button
              key={l}
              className={`eoc-item${eoc.level === l ? ' on' : ''}`}
              disabled={!by.trim()}
              title={by.trim() ? undefined : 'Enter "changed by" first — every change logs with attribution'}
              onClick={() => {
                setFailed(false)
                void changeEocLevel(l as 1 | 2 | 3 | 4, by.trim()).then((ok) => {
                  // A failed change must not look identical to a successful
                  // one — keep the menu open and say so.
                  if (ok) setOpen(false)
                  else setFailed(true)
                })
              }}
            >
              {LABELS[l]}
            </button>
          ))}
          {failed && <div className="eoc-note failed">CHANGE FAILED — SERVER UNREACHABLE</div>}
          <div className="eoc-note">Manual change only · immutable history on the citywide timeline</div>
        </div>
      )}
    </div>
  )
}

/**
 * ISOLATE cluster as ONE dropdown: the on/off toggle plus the MODEL / LIVE
 * view and the model's vertical scale — three controls that used to take
 * three top-bar slots.
 */
function IsolateMenu() {
  const { isolateMode, isolateView, isolateScale } = useAppSlice((s) => ({ isolateMode: s.isolateMode, isolateView: s.isolateView, isolateScale: s.isolateScale }))
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])
  return (
    <div className="isolate-wrap" ref={wrapRef}>
      <button
        className={`chip chip-btn amber${isolateMode ? ' active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Isolate the incident building — clip everything else away; pick MODEL or LIVE view and the model's vertical scale"
      >
        <span className="dot" /> ISOLATE {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="isolate-menu glass">
          <button
            className={`iso-toggle${isolateMode ? ' on' : ''}`}
            onClick={toggleIsolateMode}
            title="Strip every building, tree, and obstruction except the incident building"
          >
            {isolateMode ? '◉ ISOLATE ON — click to exit' : '◌ ISOLATE OFF — click to isolate the building'}
          </button>
          {isolateMode && (
            <>
              <div className="iso-label">VIEW</div>
              <span className="chip seg">
                <button
                  className={`seg-btn${isolateView === 'model' ? ' on' : ''}`}
                  onClick={() => setIsolateView('model')}
                  title="Clean schematic 3D model from the building's real data — floors, entrances, estimated egress and stairs"
                >
                  MODEL
                </button>
                <button
                  className={`seg-btn${isolateView === 'live' ? ' on' : ''}`}
                  onClick={() => setIsolateView('live')}
                  title="The real (clipped) imagery of the building"
                >
                  LIVE
                </button>
              </span>
              {isolateView === 'model' && (
                <>
                  <div className="iso-label">VERTICAL SCALE</div>
                  <span
                    className="chip seg"
                    title="Stretch the model's floors so unit tracking reads at a glance (real dimensions stay on the header)"
                  >
                    {[1, 1.5, 2].map((k) => (
                      <button
                        key={k}
                        className={`seg-btn${isolateScale === k ? ' on' : ''}`}
                        onClick={() => setIsolateScale(k)}
                      >
                        {k}×
                      </button>
                    ))}
                  </span>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// SITREP / VIDEO / BIO / FLOORS all open tabs of the SAME right-side utility
// dock — one PANELS dropdown instead of four top-bar chips.
const PANEL_TABS = [
  { id: 'sitrep', label: 'SITREP', hint: 'Live situation summary' },
  { id: 'video', label: 'VIDEO', hint: 'Drone / helicopter / body-cam feeds' },
  { id: 'bio', label: 'BIO', hint: 'Member biometrics + rotation advisories' },
  { id: 'floors', label: 'FLOORS', hint: 'Floor-by-floor member accountability' },
] as const

type PanelTabId = (typeof PANEL_TABS)[number]['id']

function PanelsMenu({
  utilityTab,
  toggleTab,
}: {
  utilityTab: string | null
  toggleTab: (tab: PanelTabId) => void
}) {
  const { panelOffsets } = useAppSlice((s) => ({ panelOffsets: s.panelOffsets }))
  const layoutMoved = Object.keys(panelOffsets).length > 0
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])
  const active = PANEL_TABS.find((t) => t.id === utilityTab)
  return (
    <div className="panels-wrap" ref={wrapRef}>
      <button
        className={`chip chip-btn${active ? ' active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Utility panels — SITREP, video feeds, biometrics, floor accountability"
      >
        <span className="dot" /> {active ? `PANELS · ${active.label}` : 'PANELS'} {open ? '▴' : '▾'}
        {layoutMoved && <span className="wc-chip-badge" title="Boxes have been moved — RESET LAYOUT inside">·</span>}
      </button>
      {open && (
        <div className="panels-menu glass">
          <button
            className="panel-item"
            onClick={() => {
              setOpen(false)
              resetPanelLayout()
            }}
            title="Every info box you dragged returns to its default position"
          >
            RESET LAYOUT
          </button>
          <button
            className="panel-item"
            onClick={() => {
              setOpen(false)
              setAppState({ policyEditorOpen: true })
            }}
            title="Cross-agency visibility policy — hot-reloads on every dashboard (admin)"
          >
            POLICY · ADMIN
          </button>
          {PANEL_TABS.map((t) => (
            <button
              key={t.id}
              className={`panel-item${utilityTab === t.id ? ' on' : ''}`}
              onClick={() => {
                toggleTab(t.id)
                setOpen(false)
              }}
              title={t.hint}
            >
              <span className="dot" /> {t.label}
              <i>{t.hint}</i>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const LAYER_LABEL: Record<string, string> = {
  footprints: 'FOOTPRINTS',
  pluto: 'PLUTO',
  hydrants: 'HYDRANTS',
  firehouses: 'FIREHOUSES',
  safety: 'DOB DATA',
  persistence: 'PERSISTENCE',
}

/**
 * Prompt 12 — the workspace profile switcher lives in the wordmark. Anyone
 * can switch instantly (PROFILE_SWITCHABLE flips to role-locked when sign-in
 * lands); the switch preserves map position and logs to the event log.
 */
function ProfileSwitcher() {
  const profile = useProfile()
  const { exerciseReviewDirty } = useAppSlice((s) => ({ exerciseReviewDirty: s.exerciseReviewDirty }))
  const [open, setOpen] = useState(false)
  // Switching to a profile without the AAR capability unmounts the review
  // panel and destroys unsaved facilitator edits — arm a two-step confirm.
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])
  const active = PROFILES.find((p) => p.id === profile) ?? PROFILES[0]
  return (
    <div className="wordmark" ref={wrapRef}>
      <span className="sub">{active.sub}</span>
      <div className="brand-row">
        <button
          className="name profile-btn"
          disabled={!PROFILE_SWITCHABLE}
          onClick={() => setOpen((o) => !o)}
          title="Switch workspace profile — instant, map position preserved, logged"
        >
          {active.label.toUpperCase()} {open ? '▴' : '▾'}
        </button>
        <IncidentsMenu />
      </div>
      {open && (
        <div className="profile-menu glass">
          {PROFILES.map((p) => {
            const losesAar = exerciseReviewDirty && !hasCapability(p.id, 'aar.hseep-exercise')
            const armed = confirmId === p.id
            return (
              <button
                key={p.id}
                className={`profile-item${p.id === profile ? ' on' : ''}${armed ? ' warn' : ''}`}
                onClick={() => {
                  if (losesAar && !armed) {
                    setConfirmId(p.id)
                    return
                  }
                  setOpen(false)
                  setConfirmId(null)
                  setProfile(p.id)
                }}
              >
                <b>{armed ? 'DISCARD UNSAVED AAR EDITS?' : p.label}</b>
                <i>{armed ? 'This profile has no AAR review — switching loses your edits. Click again to proceed.' : p.sub}</i>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** WATCH CMD chip with an attention badge: pending weather suggestions and
 *  ack-threshold breaches only render inside the citywide view, so without
 *  this an operator on the tactical board never learns they exist. */
function WatchCmdChip({ watchCommand }: { watchCommand: boolean }) {
  const { triggerSuggestions, interagencyRequests, requestThresholds } = useAppSlice((s) => ({
    triggerSuggestions: s.triggerSuggestions,
    interagencyRequests: s.interagencyRequests,
    requestThresholds: s.requestThresholds,
  }))
  const pending = triggerSuggestions.filter((s) => s.state === 'pending').length
  const breaches = interagencyRequests.filter((r) => requestElapsed(r, requestThresholds).breach).length
  const n = pending + breaches
  const attention = n > 0 && !watchCommand
  return (
    <button
      className={`chip chip-btn${watchCommand ? ' active' : ''}${attention ? ' amber active' : ''}`}
      onClick={() => (watchCommand ? exitWatchCommand() : enterWatchCommand())}
      title={
        attention
          ? `${pending ? `${pending} pending weather suggestion${pending === 1 ? '' : 's'}` : ''}${pending && breaches ? ' · ' : ''}${breaches ? `${breaches} request${breaches === 1 ? '' : 's'} past ack threshold` : ''} — open Watch Command`
          : 'Watch Command — citywide multi-incident portfolio view (NYCEM coordination layer)'
      }
    >
      <span className="dot" /> {watchCommand ? '← TACTICAL' : 'WATCH CMD'}
      {attention && <span className="wc-chip-badge">{n}</span>}
    </button>
  )
}

export function TopBar() {
  const { providerMode, layers, utilityTab, incident, inspected, activeIncidentMode, viewMode, watchCommand } = useAppSlice((s) => ({ providerMode: s.providerMode, layers: s.layers, utilityTab: s.utilityTab, incident: s.incident, inspected: s.inspected, activeIncidentMode: s.activeIncidentMode, viewMode: s.viewMode, watchCommand: s.watchCommand }))
  const canManuals = useCapability('doctrine.manuals')
  const canTactics = useCapability('tactics.engine')
  const canWatch = useCapability('watchcommand.portfolio')
  const canEoc = useCapability('eoc.level-chip')
  const toggleTab = (tab: 'sitrep' | 'video' | 'bio' | 'floors') =>
    setAppState((s) => ({ utilityTab: s.utilityTab === tab ? null : tab }))
  const down = (Object.keys(layers) as (keyof typeof layers)[]).filter((k) => layers[k] === 'unavailable')
  return (
    <header className="topbar glass">
      <ProfileSwitcher />
      <SearchBar />
      <ScenariosMenu />
      <div className="topbar-right">
        {down.map((k) => (
          <span key={k} className="chip warn">
            <span className="dot" /> {LAYER_LABEL[k]} UNAVAILABLE
          </span>
        ))}
        <OverlaysMenu />
        {canManuals && (
          <button
            className="chip chip-btn"
            onClick={() => setAppState((s) => ({ manualsOpen: !s.manualsOpen }))}
            title="Ask the Manuals — cited answers from the local FDNY publications corpus"
          >
            <span className="dot" /> MANUALS
          </button>
        )}
        {incident && canTactics && (
          <button
            className="chip chip-btn amber"
            onClick={() => setAppState((s) => ({ tacticsOpen: !s.tacticsOpen }))}
            title="FFP building-type classification + cited tactics card"
          >
            <span className="dot" /> TACTICS
          </button>
        )}
        <button
          className={`chip chip-btn amber${incident && activeIncidentMode ? ' active' : ''}${!incident && !inspected ? ' disabled' : ''}`}
          aria-disabled={!incident && !inspected}
          onClick={() => {
            // aria-disabled keeps the chip keyboard-reachable (its title is
            // the only arming instruction); activateInspectedIncident is a
            // no-op without an inspected hit, so the inert state is safe.
            if (incident) toggleActiveIncidentMode()
            else void activateInspectedIncident()
          }}
          title={
            incident
              ? 'Refine the fire building; de-emphasize beyond ~4 blocks'
              : inspected
                ? `Stand up the active incident at ${inspected.hit.label} — unlocks ISOLATE + MODEL/LIVE`
                : 'Click a building or address on the map first — then this stands up the incident there'
          }
        >
          <span className="dot" /> ACTIVE INCIDENT
        </button>
        {incident && activeIncidentMode && <IsolateMenu />}
        {canWatch && <WatchCmdChip watchCommand={watchCommand} />}
        {canEoc && <EocChip />}
        <PanelsMenu utilityTab={utilityTab} toggleTab={toggleTab} />
        {providerMode && (
          <button
            className={`chip chip-btn${viewMode === 'topdown' ? ' active' : ''}`}
            onClick={() => void toggleTopDownView()}
            title={`Camera: tactical 3D ↔ straight-down top view · imagery: ${MODE_LABEL[providerMode]}`}
          >
            <span className="dot" /> {viewMode === 'topdown' ? 'TOP-DOWN' : '3D VIEW'}
          </button>
        )}
        <Clock />
      </div>
    </header>
  )
}
