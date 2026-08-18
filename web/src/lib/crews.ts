import type { Unit } from '../types'

// ---------------------------------------------------------------------------
// Shared crew/apparatus helpers for the MANUAL dashboard pages (command
// board, resource ledger). One definition of "what counts as apparatus" and
// one color-edge scheme — the boards must never disagree about who is a rig.
// ---------------------------------------------------------------------------

export const EDGE_CLASS: Record<string, string> = {
  engine: 'edge-engine',
  ladder: 'edge-ladder',
  battalion: 'edge-battalion',
  rescue: 'edge-rescue',
  ems: 'edge-ems',
}

export function edgeClassFor(category: string): string {
  return EDGE_CLASS[category] ?? 'edge-other'
}

/** 'On Scene' / 'onscene' / 'ON-SCENE' all mean the same thing on a CoT
 *  track — one normalization for every board that counts by status. */
export function normStatus(s: string | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z]/g, '')
}

// The full status vocabulary the pipelines emit (sim, scenarios, real EUDs):
// one definition of "at the box" / "coming" so the vitals strip, SIZE-UP,
// COMMAND PACK and ledger never disagree about the same rig.
// 'released' is deliberately NOT here — a released rig is leaving the box,
// and counting it as on-scene overstates the IC's resources.
const AT_BOX_SET = new Set(['onscene', 'operating', 'staged', 'command', 'arrived', 'mayday', 'rehab'])
const ENROUTE_SET = new Set(['enroute', 'dispatched', 'responding'])

export function isAtBox(status: string | undefined): boolean {
  return AT_BOX_SET.has(normStatus(status))
}

export function isEnroute(status: string | undefined): boolean {
  return ENROUTE_SET.has(normStatus(status))
}

export function isApparatus(u: Unit): boolean {
  // Slash callsigns are crew MEMBERS (E-6/1); medic is a personnel category.
  if (u.callsign.includes('/')) return false
  if (u.category === 'ff' || u.category === 'officer' || u.category === 'drone' || u.category === 'medic') return false
  return true
}
