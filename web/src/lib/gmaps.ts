// Minimal Google Maps JS API loader. Loaded on demand — never on keyless
// installs. THE single bootstrap for the whole app: StreetViewPanel and the
// size-up strip (oblique 45° / street pano) both come through here. Two
// modules each injecting their own bootstrap <script> raced at boot — Google
// detects the double inclusion and can clobber google.maps mid-initialization
// ("streetView library unavailable" on whichever consumer lost).

interface GmapsStreetViewLib {
  StreetViewPanorama: new (el: HTMLElement, opts: Record<string, unknown>) => unknown
}

interface GmapsGlobal {
  maps?: {
    importLibrary?: (name: string) => Promise<unknown>
  }
}

const importLibraryOf = () => (window as unknown as { google?: GmapsGlobal }).google?.maps?.importLibrary

let bootstrap: Promise<void> | null = null

/** Resolve once `google.maps.importLibrary` is callable, injecting the
 *  bootstrap script at most once per PAGE (DOM-checked, not module-checked,
 *  so HMR phantom module graphs can't double-inject either). */
export function ensureMapsJs(key: string): Promise<void> {
  if (!key) return Promise.reject(new Error('no key'))
  if (importLibraryOf()) return Promise.resolve()
  if (bootstrap) return bootstrap
  bootstrap = new Promise<void>((resolve, reject) => {
    // importLibrary is defined synchronously by the bootstrap — after onload
    // (or when another instance's tag already exists) a short poll bridges
    // the gap while that script finishes evaluating.
    const settle = (deadlineMs: number) => {
      const t0 = performance.now()
      const tick = () => {
        if (importLibraryOf()) return resolve()
        if (performance.now() - t0 > deadlineMs) return reject(new Error('Maps JS API did not initialize'))
        setTimeout(tick, 25)
      }
      tick()
    }
    const existing = document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]')
    if (existing) {
      settle(8000)
      return
    }
    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async`
    script.async = true
    script.onload = () => settle(2000)
    script.onerror = () => reject(new Error('Maps JS API failed to load'))
    document.head.appendChild(script)
  })
  bootstrap.catch(() => {
    bootstrap = null // allow retry after a transient failure
  })
  return bootstrap
}

let loading: Promise<GmapsStreetViewLib> | null = null

export function loadStreetViewLib(key: string): Promise<GmapsStreetViewLib> {
  if (loading) return loading
  loading = ensureMapsJs(key).then(async () => {
    const lib = (await importLibraryOf()?.('streetView')) as GmapsStreetViewLib | undefined
    if (!lib?.StreetViewPanorama) throw new Error('streetView library unavailable')
    return lib
  })
  loading.catch(() => {
    loading = null
  })
  return loading
}
