import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Prompt 12 — the cross-agency visibility policy. A plain JSON file so the
// current stance ("NYCEM sees FULL detail" per product owner) is a config
// default, and tightening it (par_member_names: aggregate_only) is a live
// edit through the admin screen — broadcast to every dashboard, no deploy.
//
// The policy deliberately CANNOT express two things (enforced elsewhere):
// life-safety event suppression, and un-excluding manifest hardExclude
// entries (FDNY doctrine on NYCEM screens, NYCEM writes to command boards).
// ---------------------------------------------------------------------------

const POLICY_PATH =
  process.env.VISIBILITY_POLICY_PATH ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../data/visibility-policy.json')

/** Field → allowed values. Unknown fields/values are rejected at the PUT. */
export const POLICY_SCHEMA: Record<string, string[]> = {
  par_member_names: ['full', 'aggregate_only'],
  riding_lists: ['full', 'aggregate_only'],
  radio_channels: ['all', 'command_only'],
}

export type VisibilityPolicy = Record<string, string>

const DEFAULT_POLICY: VisibilityPolicy = {
  par_member_names: 'full',
  riding_lists: 'full',
  radio_channels: 'all',
}

function load(): VisibilityPolicy {
  try {
    const parsed = JSON.parse(readFileSync(POLICY_PATH, 'utf8')) as Record<string, unknown>
    const out: VisibilityPolicy = { ...DEFAULT_POLICY }
    for (const [k, allowed] of Object.entries(POLICY_SCHEMA)) {
      const v = parsed[k]
      if (typeof v === 'string' && allowed.includes(v)) out[k] = v
    }
    return out
  } catch {
    return { ...DEFAULT_POLICY }
  }
}

let policy: VisibilityPolicy = load()

export function visibilityPolicy(): VisibilityPolicy {
  return policy
}

/** Validates and persists a policy update. Returns null on a bad field/value
 *  (the whole write is rejected — a policy file must never be half-valid). */
export function setVisibilityPolicy(input: unknown): VisibilityPolicy | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const next: VisibilityPolicy = { ...policy }
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const allowed = POLICY_SCHEMA[k]
    if (!allowed || typeof v !== 'string' || !allowed.includes(v)) return null
    next[k] = v
  }
  policy = next
  try {
    mkdirSync(dirname(POLICY_PATH), { recursive: true })
    writeFileSync(`${POLICY_PATH}.tmp`, JSON.stringify(policy, null, 2))
    renameSync(`${POLICY_PATH}.tmp`, POLICY_PATH)
  } catch (err) {
    console.error('[policy] failed to write visibility-policy.json:', err)
  }
  return policy
}
