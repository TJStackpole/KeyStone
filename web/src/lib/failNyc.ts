/**
 * Dev-only failure injection for the graceful-degradation acceptance test:
 * open the app with `?failNyc` and every NYC Open Data fetch throws, which must
 * surface "layer unavailable" chips — never a crash. No effect in prod builds.
 */
export function maybeFailNyc(): void {
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('failNyc')) {
    throw new Error('failNyc: simulated NYC Open Data outage')
  }
}
