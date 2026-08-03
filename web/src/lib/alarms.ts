import type { AlarmLevel } from '../types'

// ---------------------------------------------------------------------------
// THE alarm ladder — single source of truth for every surface that renders
// or compares alarm levels (command strip, decision log, SITREP, command
// board, resource ledger, brief). Before this file existed there were six
// hand-kept copies; two of them were missing 4TH/5TH and blanked the strip
// on a fifth-alarm box. Order in the array IS escalation order.
// ---------------------------------------------------------------------------

export const ALARM_LADDER: { id: AlarmLevel; label: string; short: string }[] = [
  { id: '10-75', label: '10-75', short: '10-75' },
  { id: 'all-hands', label: 'ALL HANDS', short: 'ALL HANDS' },
  { id: '2nd', label: '2ND ALARM', short: '2ND' },
  { id: '3rd', label: '3RD ALARM', short: '3RD' },
  { id: '4th', label: '4TH ALARM', short: '4TH' },
  { id: '5th', label: '5TH ALARM', short: '5TH' },
]

/** Escalation rank; unknown/absent levels rank below 10-75. */
export function alarmRank(level: string | null | undefined): number {
  return ALARM_LADDER.findIndex((a) => a.id === level)
}

/** Display label for any level — never undefined, falls back to the raw id. */
export function alarmLabel(level: string | null | undefined): string {
  return ALARM_LADDER.find((a) => a.id === level)?.label ?? (level ?? '—').toUpperCase()
}
