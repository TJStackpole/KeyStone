import { useEffect, useRef, useState } from 'react'
import {
  activateInspectedIncident,
  loadScenario,
  runDemoScenario,
  setIsolateScale,
  setIsolateView,
  toggleActiveIncidentMode,
  toggleIsolateMode,
  toggleLayer,
  toggleTopDownView,
} from '../actions'
import { setAppState, useAppSlice } from '../state/store'
import type { ToggleLayerId } from '../types'
import { resetPanelLayout } from '../lib/movable'
import { hasCapability, PROFILE_LABEL, useCapability } from '../profiles/manifest'
import { NEXT_STEP_LABEL, useNextStep } from '../lib/guidance'
import { applyLayoutPreset, LAYOUT_PRESETS } from '../lib/layouts'
import { openBrief } from '../lib/brief'
import { HarborChip } from './DataAge'
import { SearchBar } from './SearchBar'

// Map overlays that live in the top-bar OVERLAYS dropdown rather than the
// (incident-gated) Site Intel chip row — they're useful with no incident up.
// `nycemOnly`: coordination geography (agency office locations) — an FDNY
// officer reads NYPD/NYCEM presence as UNITS on the scene, not buildings on
// a map. Their own boundaries, hydro/road context, and hospitals stay.
const OVERLAYS: { id: ToggleLayerId; label: string; hint: string }[] = [
  { id: 'battalions', label: 'FDNY Battalions', hint: 'Battalion boundary lines' },
  { id: 'divisions', label: 'FDNY Divisions', hint: 'Division boundary lines' },
  { id: 'lots', label: 'Address grid', hint: 'Tax-lot borders — click inside one to load its address' },
  { id: 'roads', label: 'Road network', hint: 'Yellow overlay of every drivable street, highway, bridge, and ramp' },
  { id: 'traffic', label: 'Live traffic', hint: 'NYC DOT real-time speeds near the box — moderate (amber) and heavy (red) congestion only; free-flowing roads stay off the map' },
  { id: 'tunnels', label: 'Tunnels', hint: 'Major vehicular tunnels — Lincoln, Holland, Queens-Midtown, Hugh L. Carey (commercial access varies per tunnel)' },
  { id: 'poiFirehouses', label: 'All firehouses', hint: 'Every FDNY firehouse citywide (Facilities DB)' },
  { id: 'poiFdny', label: 'FDNY buildings', hint: 'Official FDNY buildings — HQ, offices, training, EMS stations' },
  { id: 'poiHospitals', label: 'Major hospitals', hint: 'Hospitals and acute-care hospitals citywide' },
]

function OverlaysMenu() {
  const { layerToggles } = useAppSlice((s) => ({ layerToggles: s.layerToggles }))
  const items = OVERLAYS
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

  const anyOn = items.some((o) => layerToggles[o.id])
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
          {items.map((o) => (
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
          <button
            className="panel-item practice-item no-drag"
            onClick={() => {
              setAppState({ practiceTour: true })
              setOpen(false) // the tour panel must not sit under an open menu
            }}
            title="A five-step guided practice run in plain language — fully simulated, nothing can break"
          >
            🎓 PRACTICE — LEARN THE FLOW
          </button>
          <button className="scenario-item" onClick={() => launch('demo', () => void runDemoScenario())}>
            <b>{armedId === 'demo' ? 'REPLACES THE CURRENT BOARD — CLICK AGAIN' : 'DEMO'}</b>
            <i>Structural fire, 100 Gold St — full flow, plays unattended</i>
          </button>
          <button className="scenario-item" onClick={() => launch('goldfire', () => void loadScenario('fdny-gold-fire'))}>
            <b>{armedId === 'goldfire' ? 'REPLACES THE CURRENT BOARD — CLICK AGAIN' : 'FDNY FIRE'}</b>
            <i>Working fire, Box 0087 — 10-75, all-hands, MAYDAY + FAST deploy, exposures — pure FDNY flow</i>
          </button>
          <button className="scenario-item" onClick={() => launch('fedhall', () => void loadScenario('federal-hall-fire'))}>
            <b>{armedId === 'fedhall' ? 'REPLACES THE CURRENT BOARD — CLICK AGAIN' : 'FEDERAL HALL'}</b>
            <i>Attic void fire at 26 Wall St — six-level HABS twin, spiral stairs, dome hazard</i>
          </button>
          <button className="scenario-item" onClick={() => launch('ellis', () => void loadScenario('ellis-island-search'))}>
            <b>{armedId === 'ellis' ? 'REPLACES THE CURRENT BOARD — CLICK AGAIN' : 'ELLIS ISLAND'}</b>
            <i>Hospital complex search — marine water supply, multi-building PAR, no hydrants</i>
          </button>
          <button className="scenario-item drill" onClick={() => launch('drill', () => void loadScenario('pabt-drill'))}>
            <b>{armedId === 'drill' ? 'RESTARTS THE RUNNING DRILL — CLICK AGAIN' : (
              <>DRILL{scenario?.loaded && <em className="scn-running-chip">RUNNING</em>}</>
            )}</b>
            <i>Multi-agency bus fire w/ MCI at the Port Authority Bus Terminal</i>
          </button>
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
  const { isolateMode, isolateView, isolateScale } = useAppSlice((s) => ({
    isolateMode: s.isolateMode,
    isolateView: s.isolateView,
    isolateScale: s.isolateScale,
  }))
  // The FDNY flow the operators are trained on: ACTIVE INCIDENT → check
  // ISOLATE on → structure views lock. The guidance spine decides when this
  // is THE next step so every pulse on screen agrees.
  const nextStep = useNextStep() === 'isolate'
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
        className={`chip chip-btn amber${isolateMode ? ' active' : ''}${nextStep ? ' pulse-hint' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={
          nextStep
            ? 'NEXT STEP: check ISOLATE on to lock the view to the structure — N/S/E/W sides + floor tracking'
            : 'Isolate the incident building — clip everything else away; pick MODEL or LIVE view and the model\'s vertical scale'
        }
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
            {isolateMode ? '◉ ISOLATE ON — click to exit' : '◌ ISOLATE OFF — click to isolate + lock structure views'}
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
  const canPolicyAdmin = useCapability('admin.policy-editor')
  const { panelOffsets, feedHealth, feedPanelOpen, gloveMode } = useAppSlice((s) => ({
    panelOffsets: s.panelOffsets,
    feedHealth: s.feedHealth,
    feedPanelOpen: s.feedPanelOpen,
    gloveMode: s.gloveMode,
  }))
  const layoutMoved = Object.keys(panelOffsets).length > 0
  // Trouble badge honors capability filtering — no phantom ⚠ for feeds
  // this workspace can't even see (the panel filters identically).
  const feedTrouble = Object.values(feedHealth).some(
    (f) => hasCapability('fdny', f.capabilityId) && (f.status === 'down' || f.status === 'stale'),
  )
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
        title="Utility panels — SITREP, video feeds, biometrics, floor accountability. Tip: drag any box to move it, double-click its background to minimize it"
      >
        <span className="dot" /> {active ? `PANELS · ${active.label}` : 'PANELS'} {open ? '▴' : '▾'}
        {layoutMoved && <span className="wc-chip-badge" title="Boxes have been moved — RESET LAYOUT inside">·</span>}
      </button>
      {open && (
        <div className="panels-menu glass">
          <div className="panel-presets" title="Role layouts — arrange every box for the job in one press (edge-swipe cycles these on a tablet)">
            {LAYOUT_PRESETS.map((pr) => (
              <button
                key={pr.key}
                className="preset-btn"
                title={pr.hint}
                onClick={() => {
                  setOpen(false)
                  applyLayoutPreset(pr.key)
                }}
              >
                {pr.label}
              </button>
            ))}
          </div>
          <button
            className="panel-item"
            onClick={() => {
              setOpen(false)
              resetPanelLayout()
            }}
            title="Every info box returns to its default position and size, and GLOVE MODE switches back off — one press un-messes the screen"
          >
            RESET LAYOUT
          </button>
          <button
            className={`panel-item${gloveMode ? ' on' : ''}`}
            onClick={() => {
              const next = !gloveMode
              try {
                localStorage.setItem('ks-glove', next ? '1' : '0')
              } catch {
                // storage blocked — session-only is fine
              }
              setAppState({ gloveMode: next })
            }}
            title="Glove-and-distance mode — every control and label ~35% bigger for apparatus-cab tablets and wall displays"
          >
            GLOVE MODE{gloveMode ? ' ✓' : ''}
          </button>
          <button
            className={`panel-item${feedPanelOpen ? ' on' : ''}`}
            onClick={() => {
              setOpen(false)
              setAppState({ feedPanelOpen: !feedPanelOpen })
            }}
            title="Live-data feed health — every source's status, data age, and attribution"
          >
            LIVE FEEDS{feedTrouble ? ' ⚠' : ''}
          </button>
          {canPolicyAdmin && (
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
          )}
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

/** The wordmark: fixed FDNY brand + the citywide INCIDENTS feed. (The
 *  multi-profile switcher left with the NYCEM coordination bundle.) */
function BrandBlock() {
  return (
    <div className="wordmark">
      <span className="sub">Incident Command · FDNY</span>
      <div className="brand-row">
        <span className="name">{PROFILE_LABEL.fdny.toUpperCase()}</span>
      </div>
    </div>
  )
}

export function TopBar() {
  const { providerMode, layers, utilityTab, incident, inspected, activeIncidentMode, viewMode, viewLock, mapMode, advanced } = useAppSlice((s) => ({ providerMode: s.providerMode, layers: s.layers, utilityTab: s.utilityTab, incident: s.incident, inspected: s.inspected, activeIncidentMode: s.activeIncidentMode, viewMode: s.viewMode, viewLock: s.viewLock, mapMode: s.mapMode, advanced: s.uiAdvanced }))
  const canManuals = useCapability('doctrine.manuals')
  const canMap2d = useCapability('view.map2d')
  const nextStepId = useNextStep()
  const canTactics = useCapability('tactics.engine')
  const toggleTab = (tab: 'sitrep' | 'video' | 'bio' | 'floors') =>
    setAppState((s) => ({ utilityTab: s.utilityTab === tab ? null : tab }))
  const down = (Object.keys(layers) as (keyof typeof layers)[]).filter((k) => layers[k] === 'unavailable')
  // The bar wraps to 2-4 rows on narrow screens (iPad portrait). Publish its
  // REAL height as --topbar-h so every surface anchored beneath it (docks,
  // tool rail, strips, sheet menus) moves down instead of colliding with the
  // wrapped rows — fixed tops assumed a one-row bar and buried the incident
  // card under chips at 768px.
  const barRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const el = barRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const apply = () =>
      document.documentElement.style.setProperty('--topbar-h', `${Math.ceil(el.getBoundingClientRect().height)}px`)
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <header className="topbar glass" ref={barRef}>
      <BrandBlock />
      <SearchBar />
      <ScenariosMenu />
      <div className="topbar-right">
        {down.map((k) => (
          <span key={k} className="chip warn">
            <span className="dot" /> {LAYER_LABEL[k]} UNAVAILABLE
          </span>
        ))}
        {advanced && <OverlaysMenu />}
        {advanced && canManuals && (
          <button
            className="chip chip-btn"
            onClick={() => setAppState((s) => ({ manualsOpen: !s.manualsOpen }))}
            title="Ask the Manuals — cited answers from the local FDNY publications corpus"
          >
            <span className="dot" /> MANUALS
          </button>
        )}
        {advanced && incident && canTactics && (
          <button
            className="chip chip-btn amber"
            onClick={() => setAppState((s) => ({ tacticsOpen: !s.tacticsOpen }))}
            title="FFP building-type classification + cited tactics card"
          >
            <span className="dot" /> TACTICS
          </button>
        )}
        <button
          className={`chip chip-btn amber${incident && activeIncidentMode ? ' active' : ''}${!incident && !inspected ? ' disabled' : ''}${nextStepId === 'active-incident' ? ' pulse-hint' : ''}`}
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
        {nextStepId && (
          <span
            className="chip next-chip"
            title="The trained next action — the matching control is glowing. One lit step at a time."
          >
            NEXT · {NEXT_STEP_LABEL[nextStepId]}
          </span>
        )}
        {incident && activeIncidentMode && <IsolateMenu />}
        <HarborChip />
        {advanced && (
          <button
            className="chip chip-btn"
            onClick={openBrief}
            title="One-page plain-language situation brief in a new tab — print it, read it on the phone, or hand it over at shift change"
          >
            <span className="dot" /> BRIEF
          </button>
        )}
        {advanced && <PanelsMenu utilityTab={utilityTab} toggleTab={toggleTab} />}
        <button
          className={`chip chip-btn${advanced ? ' active' : ''}`}
          onClick={() => {
            const next = !advanced
            setAppState({ uiAdvanced: next })
            localStorage.setItem('ks-advanced', next ? '1' : '0')
          }}
          title={
            advanced
              ? 'ADVANCED is on: full toolset (overlays, manuals, tactics, panels, deep intel). Tap to return to the simple COMMAND view.'
              : 'COMMAND view shows the essentials. Tap for the full toolset — overlays, manuals, tactics, panels, deep building intel.'
          }
        >
          <span className="dot" /> {advanced ? 'ADVANCED ✓' : 'ADVANCED'}
        </button>
        {providerMode && viewLock === 'off' && !(canMap2d && mapMode === '2d') && (
          // Hidden (not just disabled) while the battle-view rail owns the
          // camera — a dead chip that duplicates the rail's TOP is clutter.
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
