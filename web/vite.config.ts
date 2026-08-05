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
    {
      // vite-plugin-cesium injects a CLASSIC script tag for the 5.9 MB
      // Cesium.js into <head> — parser-blocking, so prod first paint waits
      // for the full download+parse. defer keeps execution order (deferred
      // scripts run before module scripts) while unblocking the dark shell.
      name: 'defer-cesium-script',
      enforce: 'post' as const,
      transformIndexHtml(html: string) {
        return html.replace(/<script src="([^"]*cesium[^"]*\.js)">/i, '<script defer src="$1">')
      },
    },
  ],
  // One .env at the repo root serves web + server. Only the two 3D-provider keys
  // are ever exposed to the client (they are client-side keys by design).
  envDir: path.resolve(__dirname, '..'),
  envPrefix: ['VITE_', 'GOOGLE_MAPS_API_KEY', 'CESIUM_ION_TOKEN', 'SOCRATA_APP_TOKEN', 'DEEPGRAM_API_KEY'],
  server: {
    // Ports follow the same overrides the server honors, so a second stack
    // (e.g. a git worktree checkout) can run beside the main one.
    port: Number(process.env.WATCHTOWER_WEB_PORT ?? 5173),
    proxy: {
      '/api': `http://localhost:${process.env.WATCHTOWER_SERVER_PORT ?? 4010}`,
      '/ws': { target: `ws://localhost:${process.env.WATCHTOWER_SERVER_PORT ?? 4010}`, ws: true },
    },
  },
})
