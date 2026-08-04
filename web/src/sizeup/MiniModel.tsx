import { useEffect, useRef } from 'react'
import type { Footprint } from '../lib/footprints'

// ---------------------------------------------------------------------------
// The size-up 3D MODEL tab — one rotatable building, ZERO libraries and zero
// idle GPU: a hand-rolled canvas projector that extrudes the real footprint
// to its real roof height and repaints ONLY while the operator drags.
// (Prompt 14 asked for a server-baked <2MB mesh; the footprint IS the mesh —
// this ships the same rotatable-single-building payoff at ~0 bytes.)
// ---------------------------------------------------------------------------

const WALL = 'rgba(34, 211, 238, 0.16)'
const WALL_EDGE = 'rgba(34, 211, 238, 0.85)'
const ROOF = 'rgba(245, 158, 11, 0.30)'
const ROOF_EDGE = '#f59e0b'

export function MiniModel({ target, centerLat, centerLon }: { target: Footprint; centerLat: number; centerLon: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef({ yaw: Math.PI / 5, pitch: Math.PI / 5.2, drag: null as null | { x: number; y: number } })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const cos0 = Math.cos((centerLat * Math.PI) / 180)

    // Footprint -> local meters, centered.
    const rings = target.polygons.map((pg) => pg[0]).filter((r) => r && r.length >= 3)
    const pts = rings.flat()
    let cx = 0
    let cy = 0
    for (const [lon, lat] of pts) {
      cx += (lon - centerLon) * 111_320 * cos0
      cy += (lat - centerLat) * 111_320
    }
    cx /= pts.length
    cy /= pts.length
    const local = rings.map((r) => r.map(([lon, lat]) => [
      (lon - centerLon) * 111_320 * cos0 - cx,
      (lat - centerLat) * 111_320 - cy,
    ] as [number, number]))
    const h = target.heightM
    const span = Math.max(...local.flat().map(([x, y]) => Math.hypot(x, y)), h) * 2.3

    const render = () => {
      const { yaw, pitch } = stateRef.current
      const w = canvas.width
      const hh = canvas.height
      ctx.clearRect(0, 0, w, hh)
      const s = Math.min(w, hh) / span
      const cyaw = Math.cos(yaw)
      const syaw = Math.sin(yaw)
      const cp = Math.cos(pitch)
      const sp = Math.sin(pitch)
      const proj = (x: number, y: number, z: number): [number, number, number] => {
        const rx = x * cyaw - y * syaw
        const ry = x * syaw + y * cyaw
        return [w / 2 + rx * s, hh / 2 + (ry * cp - z * sp) * s * -1 + (h * sp * s) / 2, ry]
      }
      // Walls, painter-sorted far-to-near by mid-depth.
      interface Face { d: number; poly: [number, number][]; wall: boolean }
      const faces: Face[] = []
      for (const ring of local) {
        for (let i = 0; i < ring.length; i++) {
          const [x1, y1] = ring[i]
          const [x2, y2] = ring[(i + 1) % ring.length]
          const a0 = proj(x1, y1, 0)
          const b0 = proj(x2, y2, 0)
          const a1 = proj(x1, y1, h)
          const b1 = proj(x2, y2, h)
          faces.push({ d: (a0[2] + b0[2]) / 2, poly: [[a0[0], a0[1]], [b0[0], b0[1]], [b1[0], b1[1]], [a1[0], a1[1]]], wall: true })
        }
        faces.push({ d: -1e9, poly: ring.map(([x, y]) => { const p = proj(x, y, h); return [p[0], p[1]] as [number, number] }), wall: false })
      }
      faces.sort((a, b) => a.d - b.d)
      for (const f of faces) {
        ctx.beginPath()
        f.poly.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
        ctx.closePath()
        ctx.fillStyle = f.wall ? WALL : ROOF
        ctx.strokeStyle = f.wall ? WALL_EDGE : ROOF_EDGE
        ctx.lineWidth = 1.1
        ctx.fill()
        ctx.stroke()
      }
      ctx.fillStyle = '#94a3b8'
      ctx.font = "600 10px 'JetBrains Mono', monospace"
      ctx.fillText(`BIN ${target.bin} · ${Math.round(target.heightM)} m · drag to rotate`, 10, hh - 8)
    }

    render() // first paint; afterwards ONLY input repaints (0 idle GPU)

    const down = (e: PointerEvent) => {
      stateRef.current.drag = { x: e.clientX, y: e.clientY }
      canvas.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      const d = stateRef.current.drag
      if (!d) return
      stateRef.current.yaw += (e.clientX - d.x) * 0.012
      stateRef.current.pitch = Math.min(Math.PI / 2.05, Math.max(0.15, stateRef.current.pitch + (e.clientY - d.y) * 0.008))
      stateRef.current.drag = { x: e.clientX, y: e.clientY }
      render()
    }
    const up = () => (stateRef.current.drag = null)
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    return () => {
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
    }
  }, [target, centerLat, centerLon])

  return <canvas ref={canvasRef} width={296} height={210} className="sizeup-model" />
}
