// Minimal Google Maps JS API loader (Street View only). Loaded on demand the
// first time the Street View panel opens; never loaded on keyless installs.

interface GmapsStreetViewLib {
  StreetViewPanorama: new (el: HTMLElement, opts: Record<string, unknown>) => unknown
}

interface GmapsGlobal {
  maps?: {
    importLibrary?: (name: string) => Promise<unknown>
  }
}

let loading: Promise<GmapsStreetViewLib> | null = null

export function loadStreetViewLib(key: string): Promise<GmapsStreetViewLib> {
  if (loading) return loading
  loading = new Promise<GmapsStreetViewLib>((resolve, reject) => {
    const finish = async () => {
      try {
        const g = (window as unknown as { google?: GmapsGlobal }).google
        const lib = (await g?.maps?.importLibrary?.('streetView')) as GmapsStreetViewLib | undefined
        if (lib?.StreetViewPanorama) resolve(lib)
        else reject(new Error('streetView library unavailable'))
      } catch (err) {
        reject(err as Error)
      }
    }
    const existing = (window as unknown as { google?: GmapsGlobal }).google
    if (existing?.maps?.importLibrary) {
      void finish()
      return
    }
    const script = document.createElement('script')
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async`
    script.async = true
    script.onload = () => void finish()
    script.onerror = () => reject(new Error('Maps JS API failed to load'))
    document.head.appendChild(script)
  })
  loading.catch(() => {
    loading = null // allow retry after a transient failure
  })
  return loading
}
