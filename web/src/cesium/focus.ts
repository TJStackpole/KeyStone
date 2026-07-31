import * as Cesium from 'cesium'
import type { SceneHandle } from './providers'

// ---------------------------------------------------------------------------
// ACTIVE INCIDENT focus (user feature): when a fire is stood up, render the
// incident building as sharply as possible and de-emphasize everything beyond
// ~4 blocks. Two mechanisms, both modes covered:
//  - 3D tilesets (Google / OSM Buildings): halve the screen-space error near
//    the camera (which lives at the incident) and enable dynamic SSE so detail
//    falls off with distance — literally "far buildings matter less".
//  - A dim veil outside a 4-block radius makes the focus area explicit. It is
//    a single post-process pass (reconstruct each pixel's eye position from
//    the depth buffer, dim by distance from the incident's vertical axis) —
//    the previous ground-classification annulus rasterized a multi-pass
//    shadow volume over every visible pixel every frame, several ms of GPU.
// ---------------------------------------------------------------------------

/** ~4 Manhattan blocks. */
const FOCUS_RADIUS_M = 350
/** Full veil strength by here — soft edge starting at the focus ring. */
const VEIL_FADE_M = 430
/** Outer edge of the FALLBACK classification annulus (no-depth-texture GPUs). */
const MASK_OUTER_M = 2_500

const DEFAULT_SSE = 12 // photorealistic tiles stay legible even out of focus
const FOCUS_SSE = 8

// Depth -> eye-position reconstruction copied from Cesium's own post-process
// stages (AmbientOcclusionGenerate / DepthOfField in this exact build), so it
// inherits their log-depth handling. Veil color is #05080d at 0.42 — the same
// wash the classification polygon applied. Sky pixels (no depth written) stay
// untouched, matching the draped original.
const VEIL_FS = `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform vec3 u_centerEC;
uniform vec3 u_upEC;

in vec2 v_textureCoordinates;

void main(void)
{
    vec4 color = texture(colorTexture, v_textureCoordinates);
    float depth = czm_readDepth(depthTexture, v_textureCoordinates);
    if (depth >= 1.0)
    {
        out_FragColor = color;
        return;
    }
    vec2 xy = 2.0 * v_textureCoordinates - vec2(1.0);
    vec4 posEC = czm_inverseProjection * vec4(xy, depth, 1.0);
    posEC = posEC / posEC.w;
    vec3 d = posEC.xyz - u_centerEC;
    vec3 radial = d - dot(d, u_upEC) * u_upEC;
    float veil = 0.42 * smoothstep(${FOCUS_RADIUS_M.toFixed(1)}, ${VEIL_FADE_M.toFixed(1)}, length(radial));
    out_FragColor = vec4(mix(color.rgb, vec3(0.0196, 0.0314, 0.0510), veil), color.a);
}
`

function circle(lat: number, lon: number, radiusM: number, points: number): Cesium.Cartesian3[] {
  const R = 6371008.8
  const out: number[] = []
  for (let i = 0; i < points; i++) {
    const t = (i / points) * 2 * Math.PI
    out.push(
      lon + ((radiusM * Math.sin(t)) / (R * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI),
      lat + ((radiusM * Math.cos(t)) / R) * (180 / Math.PI),
    )
  }
  return Cesium.Cartesian3.fromDegreesArray(out)
}

export class FocusLayer {
  private source = new Cesium.CustomDataSource('active-incident-focus')
  private tilesetTouched = false
  private stage: Cesium.PostProcessStage | null = null
  // World anchor of the veil, mutated in place on incident change; the stage's
  // uniform callbacks re-derive the eye-space center/up from it every frame
  // (eye-space distances keep 32-bit shader math precise near the camera).
  private centerWorld = new Cesium.Cartesian3()
  private upWorld = new Cesium.Cartesian3()
  private centerEC = new Cesium.Cartesian3()
  private upEC = new Cesium.Cartesian3()

  constructor(private handle: SceneHandle) {
    void handle.viewer.dataSources.add(this.source)
  }

  /** Enable/disable the focus treatment for the given incident location. */
  apply(incident: { lat: number; lon: number } | null, enabled: boolean): void {
    this.source.entities.removeAll()
    const tileset = this.handle.buildingTileset

    if (!incident || !enabled) {
      this.removeStage()
      if (tileset && this.tilesetTouched) {
        tileset.maximumScreenSpaceError = DEFAULT_SSE
        // Restore Cesium's DEFAULTS (dynamic SSE is on by default in 1.143) —
        // forcing it off stripped the distance-LOD optimization permanently.
        tileset.dynamicScreenSpaceError = true
        tileset.dynamicScreenSpaceErrorDensity = 2.0e-4
        tileset.dynamicScreenSpaceErrorFactor = 24.0
        this.tilesetTouched = false
      }
      return
    }

    // Detail boost at the fire, graceful falloff with distance.
    if (tileset) {
      tileset.maximumScreenSpaceError = FOCUS_SSE
      tileset.dynamicScreenSpaceError = true
      tileset.dynamicScreenSpaceErrorDensity = 6.0e-4
      tileset.dynamicScreenSpaceErrorFactor = 6.0
      this.tilesetTouched = true
    }

    // Dim veil outside the 4-block focus ring.
    const scene = this.handle.viewer.scene
    Cesium.Cartesian3.fromDegrees(incident.lon, incident.lat, 0, Cesium.Ellipsoid.WGS84, this.centerWorld)
    Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(this.centerWorld, this.upWorld)
    if (scene.pickPositionSupported) {
      // Depth textures available (any WebGL2 context): one post-process pass.
      if (!this.stage) {
        this.stage = new Cesium.PostProcessStage({
          name: 'keystone_focus_veil',
          fragmentShader: VEIL_FS,
          uniforms: {
            u_centerEC: () =>
              Cesium.Matrix4.multiplyByPoint(
                this.handle.viewer.camera.viewMatrix,
                this.centerWorld,
                this.centerEC,
              ),
            u_upEC: () => {
              Cesium.Matrix4.multiplyByPointAsVector(
                this.handle.viewer.camera.viewMatrix,
                this.upWorld,
                this.upEC,
              )
              return Cesium.Cartesian3.normalize(this.upEC, this.upEC)
            },
          },
        })
        scene.postProcessStages.add(this.stage)
      }
    } else {
      // Fallback for contexts without depth textures: the old draped annulus,
      // but capped at 2.5 km (the tactical camera never frames beyond that)
      // and classifying only what the active mode actually renders.
      const classification =
        this.handle.mode === 'google'
          ? Cesium.ClassificationType.CESIUM_3D_TILE
          : this.handle.mode === 'ion'
            ? Cesium.ClassificationType.BOTH
            : Cesium.ClassificationType.TERRAIN
      this.source.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(circle(incident.lat, incident.lon, MASK_OUTER_M, 64), [
            new Cesium.PolygonHierarchy(circle(incident.lat, incident.lon, FOCUS_RADIUS_M, 48)),
          ]),
          material: Cesium.Color.fromCssColorString('#05080d').withAlpha(0.42),
          classificationType: classification,
        },
      })
    }
    // Focus ring edge.
    this.source.entities.add({
      polyline: {
        positions: [...circle(incident.lat, incident.lon, FOCUS_RADIUS_M, 48), circle(incident.lat, incident.lon, FOCUS_RADIUS_M, 48)[0]],
        width: 2.5,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString('#22d3ee').withAlpha(0.7),
          dashLength: 18,
        }),
        clampToGround: true,
      },
    })
  }

  private removeStage(): void {
    if (this.stage) {
      this.handle.viewer.scene.postProcessStages.remove(this.stage)
      this.stage = null
    }
  }
}
