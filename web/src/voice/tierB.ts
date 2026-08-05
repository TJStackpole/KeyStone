// ---------------------------------------------------------------------------
// Prompt 15 — Tier B client: ships the final transcript + a compact incident
// snapshot + the CLOSED intent manifest to the server, which asks a
// Haiku-class Claude to pick exactly one tool (or no_match). The manifest is
// generated from the same registry the grammar executes against, so the two
// tiers can never expose different action sets. No key on the client; the
// ANTHROPIC_API_KEY stays server-side and its absence degrades gracefully.
// ---------------------------------------------------------------------------

import { getAppState } from '../state/store'
import { unitEtaMin } from './registry'

export interface RemoteIntent {
  intent?: string
  slots?: Record<string, string>
  unavailable?: boolean
  reason?: string
}

function contextSnapshot(): Record<string, unknown> {
  const s = getAppState()
  const units = Object.values(s.units)
    .slice(0, 40)
    .map((u) => ({
      callsign: u.callsign,
      status: u.status ?? 'tracked',
      etaMin: (u.status ?? '').toLowerCase() === 'enroute' ? unitEtaMin(u) : null,
    }))
  return {
    incident: s.incident ? { address: s.incident.address, type: s.incident.type, alarm: s.incident.alarmLevel ?? null } : null,
    units,
    activeLayers: Object.entries(s.layerToggles)
      .filter(([, on]) => on)
      .map(([k]) => k),
    view: { mapMode: s.mapMode, viewLock: s.viewLock, page: s.dashboardPage, isolate: s.isolateMode },
  }
}

export async function interpretRemote(
  transcript: string,
  intents: { id: string; description: string; slots: Record<string, { description: string; enum?: string[] }> }[],
): Promise<RemoteIntent> {
  try {
    const res = await fetch('/api/voice/interpret', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transcript, context: contextSnapshot(), intents }),
    })
    if (res.status === 503) return { unavailable: true, reason: 'NO KEY' }
    if (!res.ok) return { unavailable: true, reason: `HTTP ${res.status}` }
    const body = (await res.json()) as { intent?: string; slots?: Record<string, string>; noMatch?: boolean }
    if (body.noMatch || !body.intent) return {}
    return { intent: body.intent, slots: body.slots ?? {} }
  } catch {
    return { unavailable: true, reason: 'UNREACHABLE' }
  }
}
