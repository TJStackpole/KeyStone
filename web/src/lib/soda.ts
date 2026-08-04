// ---------------------------------------------------------------------------
// NYC Open Data (Socrata) app token — keyless-degradable. Anonymous SODA
// requests share a brutally throttled pool; an app token (free, and DESIGNED
// to ship client-side — it identifies, it does not authenticate) moves every
// footprint/PLUTO/hydrant/firehouse call onto a dedicated allocation.
// Absent token = exactly the old behavior.
// ---------------------------------------------------------------------------

const TOKEN = (import.meta.env.SOCRATA_APP_TOKEN as string | undefined) ?? ''

/** Spread into any Socrata fetch: `fetch(url, { ...sodaInit(), signal })`. */
export function sodaInit(): { headers?: HeadersInit } {
  return TOKEN ? { headers: { 'X-App-Token': TOKEN } } : {}
}
