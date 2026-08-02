import { useAppSlice } from '../state/store'
import type { ProfileId } from './manifest'

// ---------------------------------------------------------------------------
// Prompt 12 — cross-agency visibility is CONFIGURATION, not code. The policy
// file (server/data/visibility-policy.json) controls what each profile sees
// of other agencies' data, per field, and hot-reloads over the ws — tighten
// it live in a meeting without a deploy.
//
// Two invariants the policy can NEVER override:
//  - life-safety events (mayday/MCI) are never filtered, and
//  - manifest hardExclude entries stay excluded under the most permissive
//    policy file (enforced in manifest.ts, not here).
//
// Enforcement currently lives at the rendering layer because profiles are
// freely switchable (no identity yet) — a "restricted" client could switch
// profiles anyway. When sign-in lands, this same policy file moves behind
// the ws fan-out so restricted fields never leave the server.
// ---------------------------------------------------------------------------

export type PolicyValue = string

export interface VisibilityPolicy {
  /** Member-level PAR detail for OTHER agencies: full | aggregate_only. */
  par_member_names: 'full' | 'aggregate_only'
  /** Riding lists (crew composition) for other agencies: full | aggregate_only. */
  riding_lists: 'full' | 'aggregate_only'
  /** Radio transcript channels for other agencies: all | command_only. */
  radio_channels: 'all' | 'command_only'
}

/** Product-owner default: NYCEM sees FULL detail. */
export const DEFAULT_POLICY: VisibilityPolicy = {
  par_member_names: 'full',
  riding_lists: 'full',
  radio_channels: 'all',
}

export const POLICY_FIELDS: { key: keyof VisibilityPolicy; label: string; values: string[]; hint: string }[] = [
  {
    key: 'par_member_names',
    label: 'PAR member detail',
    values: ['full', 'aggregate_only'],
    hint: 'Member-level PAR rows and SCBA/bio detail shown to coordinating profiles, or unit-level counts only',
  },
  {
    key: 'riding_lists',
    label: 'Riding lists',
    values: ['full', 'aggregate_only'],
    hint: 'Crew composition per rig shown to coordinating profiles, or headcounts only',
  },
  {
    key: 'radio_channels',
    label: 'Radio channels',
    values: ['all', 'command_only'],
    hint: 'All tactical channels for coordinating profiles, or the merged command view only',
  },
]

/**
 * Does this profile see MEMBER-LEVEL detail for the given field?
 * Own-agency data is never policy-restricted — FDNY always sees FDNY members;
 * the policy governs what a COORDINATING profile sees of others' data.
 */
export function memberDetailAllowed(
  profile: ProfileId,
  policy: VisibilityPolicy,
  field: 'par_member_names' | 'riding_lists',
): boolean {
  if (profile === 'fdny') return true
  return policy[field] !== 'aggregate_only'
}

/** Crew composition (who rides which rig) is gated by BOTH member-detail
 *  fields — the roster, globe markers, and dock tabs must agree, or the
 *  restricted field leaks on whichever surface forgot (hunt-9 finding). */
export function crewCompositionAllowed(profile: ProfileId, policy: VisibilityPolicy): boolean {
  return (
    memberDetailAllowed(profile, policy, 'par_member_names') &&
    memberDetailAllowed(profile, policy, 'riding_lists')
  )
}

/** Per-channel radio access: coordinating profiles can be restricted to the
 *  merged command view only. Own-agency tactical audio is never restricted. */
export function radioChannelsAllowed(profile: ProfileId, policy: VisibilityPolicy): boolean {
  if (profile === 'fdny') return true
  return policy.radio_channels !== 'command_only'
}

export function usePolicy(): VisibilityPolicy {
  const { visibilityPolicy } = useAppSlice((s) => ({ visibilityPolicy: s.visibilityPolicy }))
  return visibilityPolicy
}
