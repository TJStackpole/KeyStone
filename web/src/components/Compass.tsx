import { useEffect, useState } from 'react'
import { goHome, goToIncident, reorientNorth } from '../actions'
import { getScene } from '../cesium/scene'
import { useAppState } from '../state/store'

/**
 * Live compass: the needle tracks camera heading; one click swings the map
 * back to north (rotating about the view center, not the camera).
 */
export function Compass() {
  const { sceneReady, incident } = useAppState()
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
    <>
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
      <button
        className="home-btn glass"
        onClick={goHome}
        title="Return to your current location — where the platform is open (city view if location is unavailable)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="#e2e8f0" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5.5 9.5V20h13V9.5" />
          <path d="M10 20v-6h4v6" />
        </svg>
      </button>
      {incident && (
        <button className="incident-btn glass" onClick={goToIncident} title="Fly to the active incident you are responding to">
          <svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2.5c1 3-3.5 5-3.5 9a5.5 5.5 0 0 0 11 0c0-2.5-1.5-4.5-2.8-6-.4 1.3-1.2 2-2.2 2.5.3-2-.5-4.5-2.5-5.5Z" fill="rgba(245,158,11,0.25)" />
            <path d="M12 21.5a3 3 0 0 1-3-3c0-1.8 1.8-2.6 3-4.5 1.2 1.9 3 2.7 3 4.5a3 3 0 0 1-3 3Z" fill="#f59e0b" stroke="none" />
          </svg>
        </button>
      )}
    </>
  )
}
