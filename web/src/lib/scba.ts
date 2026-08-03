// ---------------------------------------------------------------------------
// SCBA air thresholds — one vocabulary for every surface that colors an air
// reading. The riding list and the BIO tab previously disagreed (1000/1500
// vs 1100/1800 psi), so a member at 1050 psi was amber on one board and red
// on the other. 1100 ≈ low-air alarm territory — VALIDATE—SME.
// ---------------------------------------------------------------------------

export const SCBA_LOW_PSI = 1100 // VALIDATE—SME
export const SCBA_WARN_PSI = 1800 // VALIDATE—SME

export type AirTone = '' | 'warn' | 'low'

export function airTone(psi: number): AirTone {
  if (psi <= SCBA_LOW_PSI) return 'low'
  if (psi <= SCBA_WARN_PSI) return 'warn'
  return ''
}
