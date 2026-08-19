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
      // vite-plugin-cesium injects Cesium.js + widgets.css into <head>. Even
      // deferred, the classic script executes BEFORE module scripts — the
      // whole app waited on a 5.9 MB download+eval it doesn't need for the
      // 2D-first boot. Strip both tags; src/cesium/loader.ts injects them at
      // idle after first paint (the plugin still serves/copies /cesium/*).
      name: 'strip-cesium-script',
      enforce: 'post' as const,
      transformIndexHtml(html: string) {
        return html
          .replace(/\s*<script[^>]*src="[^"]*cesium[^"]*\.js"[^>]*><\/script>/i, '')
          .replace(/\s*<link[^>]*href="[^"]*cesium[^"]*widgets\.css"[^>]*\/?>/i, '')
      },
    },
  ],
  // One .env at the repo root serves web + server. Only the two 3D-provider keys
  // are ever exposed to the client (they are client-side keys by design).
  envDir: path.resolve(__dirname, '..'),
  envPrefix: ['VITE_', 'GOOGLE_MAPS_API_KEY', 'CESIUM_ION_TOKEN', 'SOCRATA_APP_TOKEN', 'DEEPGRAM_API_KEY'],
  build: {
    rollupOptions: {
      output: {
        // maplibre-gl in its own chunk: app-code edits stop invalidating the
        // ~800 KB map engine in browser caches, and it downloads in parallel
        // with the app chunk on cold loads.
        manualChunks: { maplibre: ['maplibre-gl'] },
      },
    },
  },
  server: {
    // Ports follow the same overrides the server honors, so a second stack
    // (e.g. a git worktree checkout) can run beside the main one. PORT is
    // the dev harness's assigned port (autoPort) — the web app has no
    // callbacks pinned to 5173, so any port works; explicit override wins.
    port: Number(process.env.WATCHTOWER_WEB_PORT ?? process.env.PORT ?? 5173),
    proxy: {
      '/api': `http://localhost:${process.env.WATCHTOWER_SERVER_PORT ?? 4010}`,
      '/ws': { target: `ws://localhost:${process.env.WATCHTOWER_SERVER_PORT ?? 4010}`, ws: true },
    },
  },
})
