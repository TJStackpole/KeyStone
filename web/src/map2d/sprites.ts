import type * as maplibregl from 'maplibre-gl'

// ---------------------------------------------------------------------------
// Unit glyphs for the 2D tactical map — the CLAUDE.md taxonomy, rasterized
// once at startup onto tiny canvases and registered as MapLibre images:
// FDNY Engine red square · Ladder red diamond · Battalion white-on-red star
// · Rescue/Squad dark red square · EMS blue cross · NYPD navy circle ·
// ESU navy diamond · OEM orange pentagon · Drone cyan rotor.
// ---------------------------------------------------------------------------

const S = 30 // canvas px (rendered at ~0.7 icon-size for crispness)

type Draw = (ctx: CanvasRenderingContext2D) => void

function glyph(draw: Draw): ImageData {
  const c = document.createElement('canvas')
  c.width = S
  c.height = S
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, S, S)
  ctx.lineWidth = 2
  draw(ctx)
  return ctx.getImageData(0, 0, S, S)
}

const m = S / 2 // midpoint

function square(fill: string, stroke: string): Draw {
  return (ctx) => {
    ctx.fillStyle = fill
    ctx.strokeStyle = stroke
    ctx.fillRect(6, 6, S - 12, S - 12)
    ctx.strokeRect(6, 6, S - 12, S - 12)
  }
}

function diamond(fill: string, stroke: string): Draw {
  return (ctx) => {
    ctx.fillStyle = fill
    ctx.strokeStyle = stroke
    ctx.beginPath()
    ctx.moveTo(m, 4)
    ctx.lineTo(S - 4, m)
    ctx.lineTo(m, S - 4)
    ctx.lineTo(4, m)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  }
}

function circle(fill: string, stroke: string, r = m - 6): Draw {
  return (ctx) => {
    ctx.fillStyle = fill
    ctx.strokeStyle = stroke
    ctx.beginPath()
    ctx.arc(m, m, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
}

function star(bg: string, fg: string): Draw {
  return (ctx) => {
    circle(bg, fg)(ctx)
    ctx.fillStyle = fg
    ctx.beginPath()
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? m - 9 : (m - 9) / 2.4
      const a = (Math.PI / 5) * i - Math.PI / 2
      const x = m + r * Math.cos(a)
      const y = m + r * Math.sin(a)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.fill()
  }
}

function cross(bg: string, fg: string): Draw {
  return (ctx) => {
    circle(bg, fg)(ctx)
    ctx.fillStyle = fg
    ctx.fillRect(m - 3, 9, 6, S - 18)
    ctx.fillRect(9, m - 3, S - 18, 6)
  }
}

function pentagon(fill: string, stroke: string): Draw {
  return (ctx) => {
    ctx.fillStyle = fill
    ctx.strokeStyle = stroke
    ctx.beginPath()
    for (let i = 0; i < 5; i++) {
      const a = ((Math.PI * 2) / 5) * i - Math.PI / 2
      const x = m + (m - 6) * Math.cos(a)
      const y = m + (m - 6) * Math.sin(a)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  }
}

function rotor(fill: string): Draw {
  return (ctx) => {
    ctx.strokeStyle = fill
    ctx.fillStyle = fill
    ctx.beginPath()
    ctx.arc(m, m, 4, 0, Math.PI * 2)
    ctx.fill()
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      ctx.beginPath()
      ctx.arc(m + dx * 8, m + dy * 8, 5, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
}

/** category -> registered image id; anything unknown falls back to 'u-other'. */
export const UNIT_ICON: Record<string, string> = {
  engine: 'u-engine',
  ladder: 'u-ladder',
  battalion: 'u-battalion',
  rescue: 'u-rescue',
  squad: 'u-rescue',
  ems: 'u-ems',
  medic: 'u-ems',
  nypd: 'u-nypd',
  esu: 'u-esu',
  oem: 'u-oem',
  drone: 'u-drone',
  ff: 'u-member',
  officer: 'u-member',
}

export function registerUnitSprites(map: maplibregl.Map): void {
  const defs: [string, Draw][] = [
    ['u-engine', square('#dc2626', '#fecaca')],
    ['u-ladder', diamond('#dc2626', '#fecaca')],
    ['u-battalion', star('#b91c1c', '#ffffff')],
    ['u-rescue', square('#7f1d1d', '#fca5a5')],
    ['u-ems', cross('#1d4ed8', '#ffffff')],
    ['u-nypd', circle('#1e3a8a', '#bfdbfe')],
    ['u-esu', diamond('#1e3a8a', '#bfdbfe')],
    ['u-oem', pentagon('#ea580c', '#fed7aa')],
    ['u-drone', rotor('#22d3ee')],
    ['u-member', circle('#f59e0b', '#0a0e14', 5)],
    ['u-other', circle('#64748b', '#e2e8f0')],
  ]
  for (const [id, draw] of defs) {
    if (!map.hasImage(id)) map.addImage(id, glyph(draw), { pixelRatio: 2 })
  }
}
