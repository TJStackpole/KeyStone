import type { PostKind, ZoneKind } from '../types'

// ---------------------------------------------------------------------------
// ICS zone/post styling — plain strings, deliberately Cesium-free so the
// DrawToolbar (boot bundle) can style its buttons without dragging the
// city3d chunk in. The 3D ShapeLayer imports these too.
// ---------------------------------------------------------------------------

export const ZONE_STYLE: Record<ZoneKind, { label: string; css: string }> = {
  hot: { label: 'HOT ZONE', css: '#ef4444' },
  warm: { label: 'WARM ZONE', css: '#f59e0b' },
  cold: { label: 'COLD ZONE', css: '#22c55e' },
  perimeter: { label: 'PERIMETER', css: '#22d3ee' },
}

export const POST_META: Record<PostKind, { label: string; glyph: string; css: string }> = {
  icp: { label: 'ICP', glyph: 'ICP', css: '#f59e0b' },
  staging: { label: 'STAGING AREA', glyph: 'STG', css: '#22d3ee' },
  triage: { label: 'TRIAGE', glyph: 'TRI', css: '#ef4444' },
  media: { label: 'MEDIA POINT', glyph: 'MED', css: '#a78bfa' },
  transport: { label: 'EMS TRANSPORT CORRIDOR', glyph: 'TRN', css: '#4ade80' },
  // IC additions (Tablet Command / ATAK / FirstDue reference set):
  hazard: { label: 'HAZARD', glyph: 'HAZ', css: '#ef4444' },
  water: { label: 'WATER SUPPLY', glyph: 'H2O', css: '#38bdf8' },
  fast: { label: 'FAST / RIC', glyph: 'FST', css: '#f97316' },
  exposure: { label: 'EXPOSURE', glyph: 'EXP', css: '#fbbf24' },
}
