import * as Cesium from 'cesium'
import { fetchFacilities, type Facility } from '../api/nyc'
import { crispTextImage } from './streets'

// ---------------------------------------------------------------------------
// Citywide facility overlays (OVERLAYS menu): every FDNY firehouse, official
// FDNY buildings, NYPD precinct houses, major hospitals, NYCEM offices — all
// real points from the NYC Facilities Database, loaded lazily on first
// enable. Labels fade out beyond ~6 km so a citywide layer never becomes
// label soup.
// ---------------------------------------------------------------------------

export type PoiKind = 'poiFirehouses' | 'poiFdny' | 'poiPrecincts' | 'poiHospitals' | 'poiNycem'

function svg(inner: string, w = 26, h = 26): string {
  return `data:image/svg+xml;base64,${btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${inner}</svg>`,
  )}`
}

const TXT = (t: string, fill = '#ffffff') =>
  `<text x="13" y="17.5" text-anchor="middle" font-family="Arial, sans-serif" font-size="10" font-weight="700" fill="${fill}">${t}</text>`

interface PoiConfig {
  /** FacDB SoQL predicate. */
  where: string
  icon: string
  labelColor: string
}

const POI: Record<PoiKind, PoiConfig> = {
  poiFirehouses: {
    where: `factype='FIREHOUSE'`,
    icon: svg(
      `<path d="M13 3 L23 11 L21 11 L21 22 L5 22 L5 11 L3 11 Z" fill="#dc2626" stroke="#fca5a5" stroke-width="1.2" stroke-linejoin="round"/>` +
        `<rect x="10.5" y="14" width="5" height="8" fill="#7f1d1d"/>`,
    ),
    labelColor: '#fca5a5',
  },
  poiFdny: {
    // Official FDNY buildings: HQ/offices, training, EMS stations, public
    // safety facilities — not parking lots or storage yards.
    where: `opabbrev='FDNY' AND factype in('AGENCY EXECUTIVE OFFICE','AGENCY OFFICE','TRAINING FACILITY','PUBLIC SAFETY FACILITY','EMERGENCY MEDICAL STATION','EMERGENCY MEDICL STN','AMBULANCE STATION')`,
    icon: svg(`<rect x="3" y="3" width="20" height="20" rx="4" fill="#7f1d1d" stroke="#fca5a5" stroke-width="1.2"/>` + TXT('FD')),
    labelColor: '#fca5a5',
  },
  poiPrecincts: {
    where: `factype='POLICE STATION'`,
    icon: svg(
      `<path d="M13 2.5 L22.5 6 V13 C22.5 18.6 18.6 22.6 13 24 C7.4 22.6 3.5 18.6 3.5 13 V6 Z" fill="#1e3a8a" stroke="#93c5fd" stroke-width="1.2"/>` +
        TXT('PD'),
    ),
    labelColor: '#93c5fd',
  },
  poiHospitals: {
    where: `factype in('HOSPITAL','ACUTE CARE HOSPITAL')`,
    icon: svg(`<rect x="3" y="3" width="20" height="20" rx="4" fill="#1d4ed8" stroke="#bfdbfe" stroke-width="1.2"/>` + TXT('H')),
    labelColor: '#bfdbfe',
  },
  poiNycem: {
    where: `opabbrev='NYCEM' AND factype like '%OFFICE%'`,
    icon: svg(
      `<path d="M13 2.5 L23.5 10.2 L19.5 22.5 L6.5 22.5 L2.5 10.2 Z" fill="#ea580c" stroke="#fdba74" stroke-width="1.2"/>` + TXT('EM'),
    ),
    labelColor: '#fdba74',
  },
}

export class PoiLayer {
  private sources = new Map<PoiKind, Cesium.CustomDataSource>()
  private loaded = new Set<PoiKind>()
  private loading = new Set<PoiKind>()
  /** Last toggle state per kind — a fetch resolving after an OFF must not re-show. */
  private desired = new Map<PoiKind, boolean>()

  constructor(private viewer: Cesium.Viewer) {}

  /** Toggle a facility overlay; the first enable fetches + renders it. */
  setEnabled(kind: PoiKind, on: boolean): void {
    this.desired.set(kind, on)
    const existing = this.sources.get(kind)
    if (existing) existing.show = on
    if (!on || this.loaded.has(kind) || this.loading.has(kind)) return
    this.loading.add(kind)
    fetchFacilities(POI[kind].where)
      .then((facilities) => {
        this.loading.delete(kind)
        this.loaded.add(kind)
        this.render(kind, facilities)
      })
      .catch((err) => {
        this.loading.delete(kind)
        console.error(`[poi] ${kind} unavailable:`, err) // degrade, never crash
      })
  }

  private render(kind: PoiKind, facilities: Facility[]): void {
    let source = this.sources.get(kind)
    if (!source) {
      source = new Cesium.CustomDataSource(kind)
      this.sources.set(kind, source)
      void this.viewer.dataSources.add(source)
    }
    source.entities.removeAll()
    const cfg = POI[kind]
    for (let i = 0; i < facilities.length; i++) {
      const f = facilities[i]
      source.entities.add({
        id: `${kind}:${i}`,
        position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, 0),
        billboard: {
          image: cfg.icon,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(800, 1, 30_000, 0.45),
        },
      })
      source.entities.add({
        id: `${kind}:${i}:label`,
        position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, 0),
        billboard: {
          image: crispTextImage(f.name, cfg.labelColor, 22),
          scale: 0.5,
          pixelOffset: new Cesium.Cartesian2(0, -32),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          // Citywide layer: names only matter up close.
          translucencyByDistance: new Cesium.NearFarScalar(3500, 1, 7000, 0),
        },
      })
    }
    // The toggle may have flipped off while the fetch was in flight.
    source.show = this.desired.get(kind) ?? true
  }

  clear(): void {
    for (const s of this.sources.values()) s.entities.removeAll()
    this.loaded.clear()
  }
}
