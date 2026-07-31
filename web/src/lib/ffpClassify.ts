import type { PlutoAttributes } from '../api/nyc'

// ---------------------------------------------------------------------------
// Module 3 — FFP building-type classification from PUBLIC data (PLUTO
// building class + land use + year built + floors). Every rule here is a
// heuristic mapping of open-data attributes onto FFP Volume 1 building
// types — thresholds are estimates and the UI renders a VALIDATE—SME tag.
// The IC can override with one tap; overrides are logged to the timeline.
// ---------------------------------------------------------------------------

export type FfpType =
  | 'md_olt'
  | 'md_nlt'
  | 'brownstone_rowframe'
  | 'vacant'
  | 'taxpayer'
  | 'highrise_office'
  | 'private_dwelling'
  | 'loft'
  | 'worship'
  | 'unclassified'

export const FFP_TITLES: Record<FfpType, string> = {
  md_olt: 'Multiple Dwelling — Old Law Tenement',
  md_nlt: 'Multiple Dwelling — New Law / Fireproof',
  brownstone_rowframe: 'Brownstone / Row Frame',
  vacant: 'Vacant Building',
  taxpayer: 'Taxpayer / Strip Store',
  highrise_office: 'High-Rise Office Building',
  private_dwelling: 'Private Dwelling',
  loft: 'Loft Building',
  worship: 'Place of Worship',
  unclassified: 'Unclassified — IC judgment',
}

export interface FfpClassification {
  type: FfpType
  title: string
  confidence: 'high' | 'medium' | 'low'
  /** The raw public-data attributes the rule fired on — always shown. */
  basis: string[]
}

/**
 * NYC building-class prefixes (DOF): A one-family, B two-family, C walk-up
 * multiple dwelling, D elevator multiple dwelling, K store/taxpayer,
 * L loft, M religious, O office, V vacant land.
 */
export function classifyBuilding(
  pluto: PlutoAttributes | null,
  heightM: number | null,
  activeVacateSignals = 0,
): FfpClassification {
  if (!pluto?.bldgClass) {
    return { type: 'unclassified', title: FFP_TITLES.unclassified, confidence: 'low', basis: ['No PLUTO building class available'] }
  }
  const cls = pluto.bldgClass.toUpperCase()
  const prefix = cls[0]
  const year = pluto.yearBuilt ?? 0
  const floors = pluto.numFloors ?? 0
  const basis = [
    `Bldg class ${cls}`,
    pluto.landUse ? `Land use: ${pluto.landUse}` : `Land use code ${pluto.landUseCode ?? '—'}`,
    year ? `Built ${year}` : 'Year built unknown',
    floors ? `${floors} floors` : 'Floor count unknown',
    heightM ? `${Math.round(heightM)} m roof height` : 'Height unknown',
  ]
  const c = (type: FfpType, confidence: FfpClassification['confidence'], extra?: string): FfpClassification => ({
    type,
    title: FFP_TITLES[type],
    confidence,
    basis: extra ? [...basis, extra] : basis,
  })

  // DOB vacancy signals outrank the nominal class (FFP Book 3 — vacant ops).
  if (activeVacateSignals > 0) {
    return c('vacant', 'medium', `${activeVacateSignals} active DOB vacancy signal(s) — VALIDATE—SME`)
  }
  if (prefix === 'V') return c('vacant', 'medium', 'DOF class V (vacant) — confirm structure on scene')
  if (prefix === 'M') return c('worship', 'high')
  if (prefix === 'L') return c('loft', 'high')
  if (prefix === 'O') {
    // FDNY high-rise threshold ~75 ft; 7+ stories used as the public-data
    // proxy — VALIDATE—SME.
    if (floors >= 7 || (heightM ?? 0) >= 23) return c('highrise_office', 'high')
    return c('taxpayer', 'low', 'Low-rise office — taxpayer tactics closest match')
  }
  if (prefix === 'K') return c('taxpayer', floors <= 2 ? 'high' : 'medium')
  if (prefix === 'A' || prefix === 'B') {
    // Pre-1901 3-4 story rows read as brownstone/row-frame stock.
    if (year > 0 && year < 1901 && floors >= 3) return c('brownstone_rowframe', 'medium')
    return c('private_dwelling', 'high')
  }
  if (prefix === 'C' || prefix === 'D' || prefix === 'S' || prefix === 'R') {
    if (prefix === 'C' && year > 0 && year < 1901 && floors <= 4) return c('brownstone_rowframe', 'medium')
    // Old Law = built before the 1901 Tenement House Act — VALIDATE—SME.
    if (year > 0 && year < 1901) return c('md_olt', 'medium')
    if (prefix === 'D' && (floors >= 7 || (heightM ?? 0) >= 23)) {
      return c('md_nlt', 'medium', 'Elevator MD at high-rise scale — fireproof MD tactics')
    }
    return c('md_nlt', year > 0 ? 'medium' : 'low')
  }
  return { type: 'unclassified', title: FFP_TITLES.unclassified, confidence: 'low', basis }
}
