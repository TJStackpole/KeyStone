/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly GOOGLE_MAPS_API_KEY?: string
  readonly CESIUM_ION_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
