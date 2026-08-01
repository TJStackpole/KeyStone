import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { triggerRules, type EocLevel, type TriggerRule } from './nycem.js'

// ---------------------------------------------------------------------------
// Prompt 11 Module 5 — NWS watch: polls api.weather.gov (free, keyless) for
// active watches/warnings/advisories over NYC plus the latest KNYC
// observation, and evaluates the trigger rule engine against every product.
// SUGGESTIONS ONLY: when a rule fires it emits a suggestion for a human to
// accept, snooze, or dismiss — the system never auto-activates anything.
// Exercise support: injectMockProduct() feeds a synthetic product (labeled
// SIMULATED) through the SAME evaluation path.
// ---------------------------------------------------------------------------

export interface NwsAlert {
  id: string
  event: string
  headline: string
  severity: string
  onset: string | null
  ends: string | null
  areaDesc: string
  /** GeoJSON polygon rings [lon,lat][] — NWS provides geometry for warnings. */
  polygons: [number, number][][]
  simulated?: boolean
}

export interface WeatherObs {
  stationId: string
  observedAt: string | null
  tempC: number | null
  windKt: number | null
  windDirDeg: number | null
  precipMmHr: number | null
}

export interface TriggerSuggestion {
  id: string
  ruleId: string
  plan: string
  suggestedEocLevel: EocLevel
  suggestedActions: string[]
  firedAt: string
  /** The raw NWS product that met the criteria — attached verbatim. */
  product: NwsAlert
  state: 'pending' | 'accepted' | 'snoozed' | 'dismissed'
  decidedBy?: string
  decidedAt?: string
  validateSme: boolean
}

const POLL_MS = 5 * 60_000
const UA = { headers: { 'user-agent': 'KeyStone-COP-demo (keyless pilot)', accept: 'application/geo+json' } }
// NYC alert coverage: point-based lookup covers the five boroughs.
const ALERTS_URL = 'https://api.weather.gov/alerts/active?point=40.7128,-74.0060'
const OBS_URL = 'https://api.weather.gov/stations/KNYC/observations/latest'

const SNOOZE_MS = 30 * 60_000

// Suggestions and the fired map persist like the rest of the coordination
// state: without this, a server restart during an active product re-fires
// every suggestion the operator already decided (duplicate ticker/timeline
// entries, and SUG- ids restart at 1, cross-linking old decisions).
// Env override is a TEST seam (points state at a scratch dir) — never
// required at runtime, per the keyless/zero-config rule.
const STATE_PATH =
  process.env.WEATHER_STATE_PATH ?? resolve(dirname(fileURLToPath(import.meta.url)), '../data/weather-state.json')

/** ruleId+alertId pairs already suggested; JSON-composed so ids containing
 *  delimiters can't collide or mis-parse. */
const firedKey = (ruleId: string, alertId: string) => JSON.stringify([ruleId, alertId])

export class WeatherWatch extends EventEmitter {
  private alerts: NwsAlert[] = []
  private obs: WeatherObs | null = null
  private suggestions: TriggerSuggestion[] = []
  private suggestionSeq = 1
  /** A product fires a rule ONCE (snooze re-arms it after SNOOZE_MS). */
  private fired = new Map<string, number>()
  /** fired keys that belong to SIMULATED products — exercise-scoped, so they
   *  are NEVER persisted (a restart with a pending sim suggestion would
   *  otherwise orphan the key: no alert and no suggestion left to identify
   *  it, silently blocking the scripted trigger's next run). */
  private simFired = new Set<string>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    super()
    this.loadPersisted()
    // Same shutdown contract as nycem/incidentStore: 'exit' misses signals,
    // and tsx watch SIGTERMs on every save. Signals coalesce, so the extra
    // re-raise from the sibling modules' handlers is harmless.
    process.on('exit', () => {
      if (this.flushTimer) this.flushNow()
    })
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.once(sig, () => {
        if (this.flushTimer) this.flushNow()
        process.kill(process.pid, sig)
      })
    }
  }

  start(): void {
    void this.poll()
    setInterval(() => void this.poll(), POLL_MS).unref?.()
  }

  private loadPersisted(): void {
    try {
      const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as {
        suggestions?: TriggerSuggestion[]
        fired?: [string, number | null][]
        suggestionSeq?: number
      }
      // Identify sim product ids from the RAW suggestion list (before the
      // pending filter) so legacy files' orphaned sim fired keys get purged.
      const simIds = new Set<string>()
      if (Array.isArray(parsed.suggestions)) {
        for (const s of parsed.suggestions) if (s?.product?.simulated) simIds.add(s.product.id)
        // Pending suggestions for SIMULATED products belong to a scenario
        // that died with the old process — decided ones stay as history.
        this.suggestions = parsed.suggestions.filter(
          (s) => s && typeof s === 'object' && !(s.state === 'pending' && s.product?.simulated),
        )
      }
      if (Array.isArray(parsed.fired)) {
        for (const [k, v] of parsed.fired) {
          if (typeof k !== 'string') continue
          try {
            const [, alertId] = JSON.parse(k) as [string, string]
            if (simIds.has(alertId)) continue // sim keys are exercise-scoped
          } catch {
            continue // pre-persistence legacy key shape — drop
          }
          this.fired.set(k, v === null ? Infinity : v) // Infinity JSON-encodes as null
        }
      }
      if (typeof parsed.suggestionSeq === 'number') this.suggestionSeq = parsed.suggestionSeq
    } catch {
      // first boot — nothing persisted yet
    }
  }

  private flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    try {
      mkdirSync(dirname(STATE_PATH), { recursive: true })
      // Atomic write (tmp+rename): a hard kill mid-write must not leave a
      // truncated file that silently resets seq/fired on the next boot.
      // Sim-product fired keys stay memory-only (exercise-scoped).
      const body = JSON.stringify({
        suggestions: this.suggestions,
        fired: [...this.fired.entries()].filter(([k]) => !this.simFired.has(k)),
        suggestionSeq: this.suggestionSeq,
      })
      writeFileSync(`${STATE_PATH}.tmp`, body)
      renameSync(`${STATE_PATH}.tmp`, STATE_PATH)
    } catch (err) {
      console.error('[weather] failed to write weather-state.json:', err)
    }
  }

  private flush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => this.flushNow(), 4000)
    this.flushTimer.unref?.()
  }

  snapshot() {
    return { alerts: this.alerts, obs: this.obs, suggestions: this.suggestions }
  }

  private async poll(): Promise<void> {
    try {
      const res = await fetch(ALERTS_URL, UA)
      if (res.ok) {
        const body = (await res.json()) as {
          features?: { properties?: Record<string, unknown>; geometry?: { type?: string; coordinates?: unknown } }[]
        }
        const live: NwsAlert[] = (body.features ?? []).map((f) => {
          const p = f.properties ?? {}
          return {
            id: String(p.id ?? p['@id'] ?? Math.random()),
            event: String(p.event ?? 'Unknown'),
            headline: String(p.headline ?? ''),
            severity: String(p.severity ?? 'Unknown'),
            onset: (p.onset as string) ?? null,
            ends: (p.ends as string) ?? null,
            areaDesc: String(p.areaDesc ?? ''),
            polygons: extractPolygons(f.geometry),
          }
        })
        // Simulated (exercise-injected) products persist across polls until
        // they expire — the real feed must not silently wash them out.
        const sims = this.alerts.filter((a) => a.simulated && (!a.ends || Date.parse(a.ends) > Date.now()))
        this.alerts = [...live, ...sims]
        this.emit('weather', this.snapshot())
      }
    } catch (err) {
      console.error('[weather] NWS alerts unavailable:', err) // degrade, never crash
    }
    // Evaluate OUTSIDE the fetch branch: snooze re-arm and SIMULATED exercise
    // products must keep working through an NWS outage or a fully offline
    // exercise room — otherwise snooze silently becomes a permanent dismiss.
    for (const alert of this.alerts) this.evaluate(alert)
    try {
      const res = await fetch(OBS_URL, UA)
      if (res.ok) {
        const body = (await res.json()) as { properties?: Record<string, { value: number | null } | string> }
        const p = body.properties ?? {}
        const num = (k: string) => (p[k] as { value: number | null } | undefined)?.value ?? null
        this.obs = {
          stationId: 'KNYC',
          observedAt: (p.timestamp as string) ?? null,
          tempC: num('temperature'),
          windKt: num('windSpeed') !== null ? Math.round(num('windSpeed')! * 0.539957) : null,
          windDirDeg: num('windDirection'),
          precipMmHr: num('precipitationLastHour'),
        }
        this.emit('weather', this.snapshot())
      }
    } catch {
      // observation gap is routine — keep the last one
    }
  }

  /** Exercise inject: a synthetic product runs the REAL evaluation path. */
  injectMockProduct(alert: Omit<NwsAlert, 'simulated'>): void {
    const sim: NwsAlert = { ...alert, simulated: true }
    this.alerts = [...this.alerts.filter((a) => a.id !== sim.id), sim]
    this.emit('weather', this.snapshot())
    this.evaluate(sim)
  }

  private evaluate(alert: NwsAlert): void {
    for (const rule of triggerRules()) {
      // Rules are sanitized at every entry point, but one bad rule must
      // never silently kill evaluation of the others (the throw would be
      // swallowed by poll()'s catch and mislabeled a network failure).
      try {
        if (!rule.enabled) continue
        const hit = rule.eventMatch.some((m) => alert.event.toLowerCase().includes(m.toLowerCase()))
        if (!hit) continue
        const key = firedKey(rule.id, alert.id)
        const armedAt = this.fired.get(key)
        if (armedAt !== undefined && Date.now() < armedAt) continue
        this.fired.set(key, Infinity) // fires once; snooze() re-arms with a deadline
        if (alert.simulated) this.simFired.add(key)
        const suggestion: TriggerSuggestion = {
          id: `SUG-${this.suggestionSeq++}`,
          ruleId: rule.id,
          plan: rule.plan,
          suggestedEocLevel: rule.suggestedEocLevel,
          suggestedActions: rule.suggestedActions,
          firedAt: new Date().toISOString(),
          product: alert,
          state: 'pending',
          validateSme: rule.validateSme,
        }
        this.suggestions.push(suggestion)
        if (this.suggestions.length > 50) this.suggestions.shift()
        this.flush()
        this.emit('suggestion', suggestion)
      } catch (err) {
        console.error(`[weather] rule ${(rule as { id?: string })?.id ?? '?'} evaluation failed:`, err)
      }
    }
  }

  /**
   * Scenario lifecycle reset: drop exercise-injected products, their fired
   * keys, and any still-pending suggestions they produced. Without this,
   * re-running an exercise in the same server process never re-fires its
   * scripted trigger (the fixed SIM product id stays in the fired map
   * forever — accept/dismiss/pending all block, only snooze re-arms).
   * Decided suggestions stay as history.
   */
  clearSimulated(): void {
    const simIds = new Set<string>()
    for (const a of this.alerts) if (a.simulated) simIds.add(a.id)
    for (const s of this.suggestions) if (s.product?.simulated) simIds.add(s.product.id)
    if (!simIds.size && !this.simFired.size) return
    this.alerts = this.alerts.filter((a) => !a.simulated)
    // simFired is authoritative for this process; the id scan additionally
    // catches keys restored from legacy files (belt and suspenders).
    for (const key of this.simFired) this.fired.delete(key)
    this.simFired.clear()
    for (const key of [...this.fired.keys()]) {
      try {
        const [, alertId] = JSON.parse(key) as [string, string]
        if (simIds.has(alertId)) this.fired.delete(key)
      } catch {
        this.fired.delete(key) // pre-persistence legacy key shape
      }
    }
    this.suggestions = this.suggestions.filter((s) => !(s.product?.simulated && s.state === 'pending'))
    this.flush()
    this.emit('weather', this.snapshot())
  }

  /** Human decision — accept / snooze / dismiss. ALL THREE log upstream. */
  decide(id: string, action: 'accepted' | 'snoozed' | 'dismissed', by: string): TriggerSuggestion | null {
    const s = this.suggestions.find((x) => x.id === id)
    if (!s || s.state !== 'pending') return null
    s.state = action
    s.decidedBy = by
    s.decidedAt = new Date().toISOString()
    if (action === 'snoozed') {
      const key = firedKey(s.ruleId, s.product.id)
      this.fired.set(key, Date.now() + SNOOZE_MS)
      if (s.product.simulated) this.simFired.add(key)
    }
    this.flush()
    this.emit('weather', this.snapshot())
    return s
  }

  /** A rules edit may un-match or re-match active products — re-run them. */
  reevaluate(): void {
    for (const alert of this.alerts) this.evaluate(alert)
  }
}

function extractPolygons(geometry?: { type?: string; coordinates?: unknown }): [number, number][][] {
  if (!geometry?.coordinates) return []
  try {
    if (geometry.type === 'Polygon') {
      return [(geometry.coordinates as [number, number][][])[0]]
    }
    if (geometry.type === 'MultiPolygon') {
      return (geometry.coordinates as [number, number][][][]).map((poly) => poly[0])
    }
  } catch {
    // malformed geometry — the alert still lists without a shape
  }
  return []
}

export type { TriggerRule }
