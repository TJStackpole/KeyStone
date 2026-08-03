// ---------------------------------------------------------------------------
// Shared time formatting — one shape per concept, everywhere. Before this
// file the codebase carried five hand-rolled formatters producing four
// different shapes for the same two ideas (elapsed vs wall clock), so the
// same incident read T+1:04:12 on the strip and T+01:04:12 on the board.
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0')

/** Elapsed duration: MM:SS under an hour, HH:MM:SS past it. Clamps at 0. */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return hh > 0 ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`
}

/** Wall-clock HH:MM:SS from an ISO stamp or epoch ms (local time). */
export function fmtWallClock(when: string | number): string {
  const d = new Date(when)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
