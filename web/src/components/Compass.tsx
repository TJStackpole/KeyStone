import { useEffect, useState } from 'react'
import { reorientNorth } from '../actions'
import { getScene } from '../cesium/scene'
import { useAppState } from '../state/store'

/**
 * Live compass: the needle tracks camera heading; one click swings the map
 * back to north (rotating about the view center, not the camera).
 */
export function Compass() {
  const { sceneReady } = useAppState()
  const [headingDeg, setHeadingDeg] = useState(0)

  useEffect(() => {
    if (!sceneReady) return
    const scene = getScene()
    if (!scene) return
    const camera = scene.viewer.camera
    const prev = camera.percentageChanged
    camera.percentageChanged = 0.01
    const update = () => setHeadingDeg((camera.heading * 180) / Math.PI)
    camera.changed.addEventListener(update)
    update()
    return () => {
      camera.changed.removeEventListener(update)
      camera.percentageChanged = prev
    }
  }, [sceneReady])

  if (!sceneReady) return null

  return (
    <button className="compass glass" onClick={reorientNorth} title="Reorient the map north">
      <svg viewBox="0 0 40 40" style={{ transform: `rotate(${-headingDeg}deg)` }}>
        <circle cx="20" cy="20" r="18" fill="rgba(7,12,20,0.4)" stroke="rgba(148,163,184,0.35)" strokeWidth="1" />
        <path d="M20 5 L24 20 L20 18 L16 20 Z" fill="#ef4444" />
        <path d="M20 35 L24 20 L20 22 L16 20 Z" fill="#94a3b8" />
        <text x="20" y="12.5" textAnchor="middle" fontSize="7" fontFamily="JetBrains Mono, monospace" fontWeight="700" fill="#e2e8f0">
          N
        </text>
      </svg>
    </button>
  )
}
