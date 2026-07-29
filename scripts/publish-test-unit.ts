/**
 * Phase 3 acceptance probe: publish ONE genuine CoT event for engine "E-99"
 * into the TAK server over plain TCP, exactly like an ATAK client would.
 *
 *   npx tsx scripts/publish-test-unit.ts
 *
 * The WATCHTOWER backend (a separate TCP client of the same TAK server)
 * receives the fan-out, and E-99 appears on the globe within ~2 seconds.
 * Optional env: TAK_HOST (default 127.0.0.1), TAK_PORT (default 8087).
 */
import net from 'node:net'

const HOST = process.env.TAK_HOST ?? '127.0.0.1'
const PORT = Number(process.env.TAK_PORT ?? 8087)

// Doorstep of 100 Gold Street, Manhattan.
const LAT = 40.71013
const LON = -74.00335

const now = new Date()
const stale = new Date(now.getTime() + 5 * 60 * 1000)

const xml =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<event version="2.0" uid="WT-TEST-E99" type="a-f-G-E-V-F" how="m-g"` +
  ` time="${now.toISOString()}" start="${now.toISOString()}" stale="${stale.toISOString()}">` +
  `<point lat="${LAT}" lon="${LON}" hae="5.0" ce="9999999.0" le="9999999.0"/>` +
  `<detail>` +
  `<contact callsign="E-99"/>` +
  `<__group name="Blue" role="Team Member"/>` +
  `<track course="45.0" speed="0.0"/>` +
  `<watchtower status="On Scene"/>` +
  `</detail>` +
  `</event>\n`

console.log(`[publish-test-unit] connecting to TAK server at ${HOST}:${PORT} …`)
const socket = net.connect({ host: HOST, port: PORT }, () => {
  console.log('[publish-test-unit] connected — sending CoT event for E-99:')
  console.log(xml.trim())
  socket.write(xml)
  // Give the server a beat to ingest before closing the stream.
  setTimeout(() => {
    socket.end()
    console.log('[publish-test-unit] done — E-99 should be on the globe now.')
    process.exit(0)
  }, 1500)
})

socket.on('error', (err) => {
  console.error(`[publish-test-unit] FAILED: ${err.message}`)
  console.error('Is the TAK server up? Run: docker compose up -d')
  process.exit(1)
})
