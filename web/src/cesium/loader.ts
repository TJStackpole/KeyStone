// ---------------------------------------------------------------------------
// Cesium script loader — the 5.9 MB (1.7 MB gz) Cesium.js used to sit at the
// top of <head> as a deferred script, gating every module byte of the app on
// its download + evaluation. The FDNY profile boots into the 2D MapLibre
// view, so the engine now loads AT IDLE after first paint instead (App.tsx
// schedules bootScene). vite-plugin-cesium rewrites `import from 'cesium'`
// to use-site `Cesium.X` member access, so app modules evaluate fine before
// the global exists — the only rule is that no Cesium API runs before
// ensureCesiumScript() resolves, which the sceneReady/getScene() guards
// already enforce everywhere.
// ---------------------------------------------------------------------------

let loading: Promise<void> | null = null

export function ensureCesiumScript(): Promise<void> {
  if ((window as { Cesium?: unknown }).Cesium) return Promise.resolve()
  if (loading) return loading
  loading = new Promise<void>((resolve, reject) => {
    performance.mark('keystone:cesium-fetch-start')
    const css = document.createElement('link')
    css.rel = 'stylesheet'
    css.href = '/cesium/Widgets/widgets.css'
    document.head.appendChild(css)
    const script = document.createElement('script')
    script.src = '/cesium/Cesium.js'
    script.onload = () => {
      performance.mark('keystone:cesium-loaded')
      resolve()
    }
    script.onerror = () => reject(new Error('Cesium.js failed to load'))
    document.head.appendChild(script)
  })
  loading.catch(() => {
    loading = null // transient (demo-floor wifi) — the next attempt retries
  })
  return loading
}
