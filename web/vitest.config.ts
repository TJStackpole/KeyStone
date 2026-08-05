import { defineConfig } from 'vitest/config'

// Voice-layer unit tests (grammar, safety split, deny-list). jsdom because
// the store touches localStorage at module init. The registry lazy-imports
// actions/cesium inside run(), so tests never drag the 3D stack in.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
})
