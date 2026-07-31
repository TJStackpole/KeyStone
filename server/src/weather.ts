import { EventEmitter } from 'node:events'
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

export class WeatherWatch extends EventEmitter {
  private alerts: NwsAlert[] = []
  private obs: WeatherObs | null = null
  private suggestions: TriggerSuggestion[] = []
  private suggestionSeq = 1
  /** ruleId|alertId pairs already suggested — a product fires a rule ONCE
   *  (snooze re-arms it after SNOOZE_MS). */
  private fired = new Map<string, number>()

  start(): void {
    void this.poll()
    setInterval(() => void this.poll(), POLL_MS).unref?.()
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
        for (const alert of this.alerts) this.evaluate(alert)
      }
    } catch (err) {
      console.error('[weather] NWS alerts unavailable:', err) // degrade, never crash
    }
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
      if (!rule.enabled) continue
      const hit = rule.eventMatch.some((m) => alert.event.toLowerCase().includes(m.toLowerCase()))
      if (!hit) continue
      const key = `${rule.id}|${alert.id}`
      const armedAt = this.fired.get(key)
      if (armedAt !== undefined && Date.now() < armedAt) continue
      this.fired.set(key, Infinity) // fires once; snooze() re-arms with a deadline
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
      this.emit('suggestion', suggestion)
    }
  }

  /** Human decision — accept / snooze / dismiss. ALL THREE log upstream. */
  decide(id: string, action: 'accepted' | 'snoozed' | 'dismissed', by: string): TriggerSuggestion | null {
    const s = this.suggestions.find((x) => x.id === id)
    if (!s || s.state !== 'pending') return null
    s.state = action
    s.decidedBy = by
    s.decidedAt = new Date().toISOString()
    if (action === 'snoozed') {
      this.fired.set(`${s.ruleId}|${s.product.id}`, Date.now() + SNOOZE_MS)
    }
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
