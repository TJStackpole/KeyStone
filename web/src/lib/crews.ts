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

export function isApparatus(u: Unit): boolean {
  // Slash callsigns are crew MEMBERS (E-6/1); medic is a personnel category.
  if (u.callsign.includes('/')) return false
  if (u.category === 'ff' || u.category === 'officer' || u.category === 'drone' || u.category === 'medic') return false
  return true
}
