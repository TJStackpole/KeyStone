# KeyStone NYCEM Coordination Bundle

Everything that made up the **KeyStone NYCEM** workspace — the citywide
coordination dashboard — extracted from the KeyStone FDNY platform on
2026-08-05 (commit lineage preserved in the main repo history). Drop this
bundle into another project to rebuild the NYCEM side.

## What's in here

### Full source files (verbatim at extraction time)
| File | What it is |
|---|---|
| `web/src/components/WatchCommandPanel.tsx` | Watch Command: citywide multi-incident portfolio, ticker, EOC history, weather-trigger banners, request board (kanban + queues + metrics + CSV), CIMS role labels |
| `web/src/components/ExerciseReviewPanel.tsx` | HSEEP exercise review / AAR facilitator screen (M8) |
| `web/src/components/PolicyEditorPanel.tsx` | Cross-agency visibility policy editor (admin surface) |
| `web/src/cesium/portfolioLayer.ts` | Citywide portfolio pins on the 3D globe |
| `web/src/profiles/manifest.reference.ts` | The two-profile capability manifest as it was — shows every `profiles: ['nycem']` gate |
| `server/src/nycem.ts` | Coordination state: EOC level + history, citywide ticker, plan activations, trigger rules, persistence (nycem-state.json) — **also contained the interagency request tracker, which stayed behind** (now `server/src/requests.ts` in the main repo) |
| `server/src/weather.ts` | Weather trigger engine (M5): NWS polling, rule evaluation, suggestion lifecycle, mock product injection for drills |
| `server/src/policy.ts` | Visibility-policy backend (schema + persistence) — note: a copy REMAINS in the main repo serving the policy snapshot |
| `server/src/aar.ts` + `aar.test.ts` | HSEEP AAR / exercise package generator + its suite |
| `server/src/nycem.sanitize.test.ts`, `server/src/weather.test.ts` | Suites for the above |
| `server/src/feeds/adapters/usgsGages.ts`, `openFema.ts` | NYCEM-only feed adapters (USGS stream gages, OpenFEMA) |
| `assets/scenarios/pabt-flood-exercise.json` | The two-incident NYCEM exercise (PABT drill + Queens flash flood) that drives triggers/EOC/HSEEP end-to-end |

### Excerpts (code that lived inside shared files)
| File | Origin |
|---|---|
| `excerpts/web-actions.ts.txt` | `web/src/actions.ts`: setProfile, enter/exitWatchCommand, openWatchCommandChrome, leaveWatchCommandSilently, focusPortfolioIncident, refreshWatchLayers, changeEocLevel, saveRules, finishExercise, launchDualScreenDemo |
| `excerpts/web-topbar-chips.tsx.txt` | `TopBar.tsx`: EocChip, WatchCmdChip, ProfileSwitcher (multi-profile dropdown) |
| `excerpts/web-ws-store.ts.txt` | `ws.ts` message types/cases + `store.ts` slices: portfolio, ticker, eoc, plans, triggerSuggestions/rules, weatherAlerts/obs, exerciseReview, watchCommand |
| `excerpts/web-types-manifest.ts.txt` | `types.ts` interfaces (PortfolioIncident, TickerEvent, Eoc*, PlanActivation, Trigger*, ExerciseSession, NwsAlert) + the manifest's NYCEM capability block |
| `excerpts/server-index.ts.txt` | `server/src/index.ts`: /api/nycem/* routes (eoc, plans, rules, weather, suggestions, state), /api/exercises/*, the WeatherWatch wiring, ticker broadcast helper, snapshot fields |
| `excerpts/nycem.css` | All `wc-` / `exr-` / `policy-` / `ticker-` / `eoc-` rules from theme.css (156 rules) |

## What stayed in KeyStone FDNY (deliberately)
- **Interagency request tracker** — `requests.agency-panel` is an FDNY capability
  (My Agency Requests). The server half was split out of `nycem.ts` into
  `server/src/requests.ts`; both share the same on-disk file/env seam
  (`NYCEM_DATA_PATH` → `nycem-state.json`) so state carries over.
- **`portfolio()` internals** on the server — the dispatch feed and the
  request-count plumbing read it. The `portfolio` WS broadcast still fires;
  the FDNY client simply ignores it. Re-connecting a coordination client is
  as simple as consuming that message again.
- **Visibility policy backend + `policy` snapshot** — the client policy engine
  (redaction defaults) still consumes it; only the admin editor UI left.
- The `ticker()` helper in `index.ts` is now a **stub** — call sites (request
  changes, alarm escalations) keep their shape, the timeline remains the
  record. Re-integration = restore the helper body from
  `excerpts/server-index.ts.txt` and re-add `pushTicker` from `nycem.ts`.

## Rebuilding in another project — checklist
1. Server: mount `nycem.ts` (rewire its request half or keep the split),
   `weather.ts`, `aar.ts`, `policy.ts`; restore the routes/broadcasts/snapshot
   fields from `excerpts/server-index.ts.txt`; register the two feed adapters.
2. Client: mount the three panels; restore store slices + ws cases + types
   from the excerpts; add the manifest's NYCEM block and profile entry; wire
   the TopBar chips (EOC, WATCH CMD) and the profile switcher; include
   `excerpts/nycem.css`.
3. Scenario: ship `pabt-flood-exercise.json`; the engine hooks it needs
   (openRequest/transitionRequest/injectNws/portfolioChanged) are in the
   excerpt — all optional on the engine side.
4. The dual-screen demo opened `?profile=nycem` in a second window — see
   `launchDualScreenDemo` in the actions excerpt.

Everything here follows the platform's standing rules: keyless by default,
simulated content visibly labeled SIMULATED, CIMS labels used exactly.
