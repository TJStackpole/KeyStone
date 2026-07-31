import { env } from '../env.js'

// ---------------------------------------------------------------------------
// Per-stack simulator uid namespace. Parallel dev stacks (main checkout plus
// a worktree) share the single Docker TAK server, so without a namespace both
// simulators publish IDENTICAL uids (WT-SIM-E-6) and every shared unit
// ping-pongs between the two incidents on BOTH dashboards every tick — which
// also defeats the units.batch change gate's bandwidth savings.
//
// The namespace rides inside the uid (WT-SIM-<ns>-E-6; scenario-engine drill
// entities DRILL-<ns>-E-3-4): each stack ingests only its own namespace
// (units.ts drops the rest), while real EUD uids — which never carry either
// prefix — always pass. Default is the server port: distinct per parallel
// stack by construction (two stacks can't bind one port) and stable across
// restarts. Pin it with WATCHTOWER_SIM_NS when port-derived isn't wanted.
// ---------------------------------------------------------------------------

// The port default mirrors index.ts exactly (process env only — the listen
// port never comes from .env), so namespace and port cannot drift apart.
const raw = env('WATCHTOWER_SIM_NS', process.env.WATCHTOWER_SERVER_PORT ?? '4010')

// No dashes inside the namespace — '-' delimits uid segments, and a ns that
// is a dash-prefix of another ns (a vs a-b) would defeat the prefix match.
export const SIM_NS = raw.replace(/[^A-Za-z0-9_]/g, '') || '4010'

/** Uid prefix for every simulated unit THIS stack publishes. */
export const SIM_UID_PREFIX = `WT-SIM-${SIM_NS}-`

/** Uid/id prefix for everything THIS stack's scenario engine publishes
 *  (drill units, drill shape CoT). */
export const DRILL_UID_PREFIX = `DRILL-${SIM_NS}-`

/**
 * A parallel dev stack's simulated unit: same TAK server, same WT-SIM-/DRILL-
 * family, different namespace. Its fleet belongs to that stack's incident,
 * not ours. Un-namespaced family uids (a stack still running pre-namespace
 * code) are foreign by the same rule — this stack never publishes them.
 */
export function isForeignSimUid(uid: string): boolean {
  return (
    (uid.startsWith('WT-SIM-') && !uid.startsWith(SIM_UID_PREFIX)) ||
    (uid.startsWith('DRILL-') && !uid.startsWith(DRILL_UID_PREFIX))
  )
}
