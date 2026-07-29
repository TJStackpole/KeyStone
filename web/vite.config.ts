import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import cesium from 'vite-plugin-cesium'
import path from 'node:path'

// npm workspaces hoist cesium to the monorepo root; vite-plugin-cesium's default
// paths are CWD-relative and would silently serve nothing (Vite then answers every
// /cesium/* request with index.html — which hangs Cesium's web workers and with
// them all terrain/imagery streaming). Point it at the hoisted package explicitly.
const cesiumBuildRoot = path.resolve(__dirname, '../node_modules/cesium/Build')

export default defineConfig({
  plugins: [
    react(),
    cesium({
      cesiumBuildRootPath: cesiumBuildRoot,
      cesiumBuildPath: path.join(cesiumBuildRoot, 'Cesium/'),
    }),
  ],
  // One .env at the repo root serves web + server. Only the two 3D-provider keys
  // are ever exposed to the client (they are client-side keys by design).
  envDir: path.resolve(__dirname, '..'),
  envPrefix: ['VITE_', 'GOOGLE_MAPS_API_KEY', 'CESIUM_ION_TOKEN'],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4010',
      '/ws': { target: 'ws://localhost:4010', ws: true },
    },
  },
})
