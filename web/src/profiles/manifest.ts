import { useAppSlice } from '../state/store'

// ---------------------------------------------------------------------------
// Prompt 12 — the capability manifest. ONE declarative source of truth for
// what renders in each workspace profile. Components never ask "am I FDNY?"
// — they ask hasCapability(profile, 'some.capability'). Adding a future
// profile (NYPD, PAPD, OEM-field) must require only entries here, zero
// component changes.
//
// Two kinds of exclusion, deliberately distinct:
//  - profiles list        = product configuration (can evolve freely)
//  - hardExclude          = political survival lines, enforced here at the
//    manifest layer and NEVER overridable by visibility_policy.json:
//    FDNY doctrine never renders on a coordinating agency's screen, and
//    NYCEM never gets write access to another agency's command board.
// ---------------------------------------------------------------------------

export type ProfileId = 'fdny' | 'nycem'

export const PROFILES: { id: ProfileId; label: string; sub: string }[] = [
  { id: 'fdny', label: 'KeyStone FDNY', sub: 'Incident Command · FDNY' },
  { id: 'nycem', label: 'KeyStone NYCEM', sub: 'Citywide Coordination · NYCEM · CIMS' },
]

export const PROFILE_LABEL: Record<ProfileId, string> = { fdny: 'KeyStone FDNY', nycem: 'KeyStone NYCEM' }

/** Free switching for the pilot; a sign-in role can constrain this later by
 *  flipping ONE flag — do not scatter switchability assumptions elsewhere. */
export const PROFILE_SWITCHABLE = true

export interface Capability {
  /** Which profiles render this. 'both' is the shared core. */
  profiles: ProfileId[] | 'both'
  /** Profiles that must NEVER see this regardless of visibility policy —
   *  with the reason, because each of these is a relationship decision. */
  hardExclude?: Partial<Record<ProfileId, string>>
  /** Whose data this surface shows (informs the policy layer). */
  visibilityScope?: 'own_agency' | 'all_agencies'
  sensitivity?: 'normal' | 'member_pii' | 'tactical_audio'
}

export const CAPABILITIES: Record<string, Capability> = {
  // ---- SHARED CORE (renders identically in both profiles) ----------------
  'map.3d': { profiles: 'both' },
  'search.address': { profiles: 'both' },
  'intel.building-card': { profiles: 'both' }, // open-data profile
  'intel.site-panel': { profiles: 'both' },
  'ics.zones': { profiles: 'both' }, // collapse / hot-warm-cold / perimeter
  'ics.posts': { profiles: 'both' }, // CP, staging/base markers
  'ics.draw-tools': { profiles: 'both' },
  'incident.core': { profiles: 'both' }, // incident object + event log + timeline
  'incident.active-focus': { profiles: 'both' },
  'incident.isolate': { profiles: 'both' },
  'scenario.playback': { profiles: 'both' },
  'weather.wind-layer': { profiles: 'both' }, // NWS wind + advisory
  'overlays.map': { profiles: 'both' },
  'incidents.dispatch-feed': { profiles: 'both' }, // SIMULATED citywide feed dropdown
  'comms.transcripts': { profiles: 'both', visibilityScope: 'all_agencies', sensitivity: 'tactical_audio' },
  'chat.tak': { profiles: 'both' },
  'video.panels': { profiles: 'both', sensitivity: 'tactical_audio' },
  'sitrep.summary': { profiles: 'both' },
  'streetview.panel': { profiles: 'both' },
  'alerts.mayday-banner': { profiles: 'both' }, // life-safety: NEVER filtered
  'roster.units': { profiles: 'both', visibilityScope: 'all_agencies', sensitivity: 'member_pii' },
  'bio.telemetry': { profiles: 'both', sensitivity: 'member_pii' },
  'floors.tracking': { profiles: 'both', sensitivity: 'member_pii' },
  'admin.policy-editor': { profiles: 'both' }, // admin-only once identity exists

  // ---- KEYSTONE FDNY (tactical command posture) ---------------------------
  'doctrine.manuals': {
    profiles: ['fdny'],
    hardExclude: { nycem: 'Internal FDNY documents — never rendered through a coordinating agency, regardless of policy' },
  },
  'tactics.engine': { profiles: ['fdny'] }, // building-type tactics + FFP cards
  'aar.drill-debrief': { profiles: ['fdny'] }, // tactical drill AAR (Phase 8)
  'requests.agency-panel': { profiles: ['fdny'], visibilityScope: 'own_agency' }, // slim "My Agency Requests"
  'mayday.interactive-flow': { profiles: ['fdny'] }, // FAST workflow / MID checklist (banner stays 'both')
  // Reserved for Prompt 10 M5-9 when they land — profile-ready on arrival:
  'commandboard.view': { profiles: 'both' },
  'commandboard.write': {
    profiles: ['fdny'],
    hardExclude: { nycem: 'Coordination ≠ command: a tool that lets NYCEM move FDNY units gets KeyStone banned from every firehouse' },
  },
  'nyfirs.draft': { profiles: ['fdny'] },
  'stackview.highrise': { profiles: ['fdny'] },
  'subsurface.power': { profiles: ['fdny'] },
  'rtf.mode': { profiles: ['fdny'] },
  'rehab.tracking': { profiles: ['fdny'] },
  'collapse.checklist': { profiles: ['fdny'] },

  // ---- KEYSTONE NYCEM (citywide coordination posture) ---------------------
  'watchcommand.portfolio': { profiles: ['nycem'], visibilityScope: 'all_agencies' },
  'eoc.level-chip': { profiles: ['nycem'] },
  'ticker.citywide': { profiles: ['nycem'] },
  'requests.board-full': { profiles: ['nycem'], visibilityScope: 'all_agencies' }, // kanban + queues + metrics + CSV
  'weather.trigger-rules': { profiles: ['nycem'] },
  'aar.hseep-exercise': { profiles: ['nycem'] },
  'cims.role-labels': { profiles: ['nycem'] },
}

export function hasCapability(profile: ProfileId, id: string): boolean {
  const cap = CAPABILITIES[id]
  if (!cap) return false // unknown capability renders nowhere — fail closed
  if (cap.hardExclude?.[profile]) return false
  return cap.profiles === 'both' || cap.profiles.includes(profile)
}

/** Rendering gate — the ONLY way components should consult the profile. */
export function useCapability(id: string): boolean {
  const { profile } = useAppSlice((s) => ({ profile: s.profile }))
  return hasCapability(profile, id)
}

export function useProfile(): ProfileId {
  const { profile } = useAppSlice((s) => ({ profile: s.profile }))
  return profile
}
