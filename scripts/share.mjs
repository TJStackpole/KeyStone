#!/usr/bin/env node
// ---------------------------------------------------------------------------
// `npm run share` — the whole platform on a shareable URL in one command:
//   1. builds server + web (skipped with --no-build if dist is fresh)
//   2. starts the single ship-mode process (static app + /api + /ws)
//   3. opens a Cloudflare QUICK TUNNEL (no account, no key — keyless rule)
//      and prints the public https://….trycloudflare.com URL.
// The laptop must stay on and online; the URL changes on every run. For a
// permanent host, see DEPLOY.md.
// ---------------------------------------------------------------------------
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.WATCHTOWER_SERVER_PORT ?? 4010)
const skipBuild = process.argv.includes('--no-build')

const cf = spawnSync('which', ['cloudflared'])
if (cf.status !== 0) {
  console.error('\ncloudflared is not installed — the quick tunnel needs it (no account required):')
  console.error('  brew install cloudflared   # macOS')
  console.error('  https://developers.cloudflare.com/cloudflared/  # other platforms\n')
  process.exit(1)
}

if (!skipBuild || !existsSync(join(root, 'web/dist/index.html')) || !existsSync(join(root, 'server/dist/index.js'))) {
  console.log('▸ building server + web…')
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
  if (build.status !== 0) process.exit(build.status ?? 1)
}

// Port preflight: the most likely morning-of mistake is running `npm run
// share` while the dev stack still holds the port — fail with the fix, not
// a stack trace.
const portBusy = await new Promise((resolveBusy) => {
  import('node:net').then(({ createServer }) => {
    const probe = createServer()
    probe.once('error', () => resolveBusy(true))
    probe.once('listening', () => probe.close(() => resolveBusy(false)))
    // No host: bind dual-stack (::) exactly like the server does — a
    // 127.0.0.1 probe reports free while the dev stack holds :::PORT.
    probe.listen(PORT)
  })
})
if (portBusy) {
  console.error(`\n✗ port ${PORT} is already in use — probably the dev stack (npm run dev).`)
  console.error(`  Stop it first, or run on another port:`)
  console.error(`  WATCHTOWER_SERVER_PORT=4011 npm run share\n`)
  process.exit(1)
}

console.log(`▸ starting ship-mode server on :${PORT}…`)
const server = spawn('node', ['server/dist/index.js'], {
  cwd: root,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, NODE_ENV: 'production' },
})

console.log('▸ opening the quick tunnel…')
const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})

let announced = false
// Quick tunnels are best-effort: if no URL shows up, say so instead of
// leaving the operator staring at a silent prompt.
const watchdog = setTimeout(() => {
  if (!announced) {
    console.error('⚠ 30s without a tunnel URL — cloudflared may be blocked (network egress / Cloudflare outage).')
    console.error('  Ctrl-C and retry, or run locally instead: npm run ship  →  http://localhost:' + PORT)
  }
}, 30_000)
const sniff = (chunk) => {
  const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
  if (m && !announced) {
    announced = true
    clearTimeout(watchdog)
    const url = m[0]
    const bar = '═'.repeat(url.length + 14)
    console.log(`\n╔${bar}╗`)
    console.log(`║   KEYSTONE →  ${url}   ║`)
    console.log(`╚${bar}╝`)
    console.log('Share that link. It stays live while this window stays open (Ctrl-C stops everything).\n')
  }
}
tunnel.stdout.on('data', sniff)
tunnel.stderr.on('data', sniff)

let shuttingDown = false
const stop = () => {
  shuttingDown = true
  tunnel.kill('SIGINT')
  server.kill('SIGINT')
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
server.on('exit', (code) => {
  if (shuttingDown) return
  shuttingDown = true
  console.error(`server exited (${code}) — closing tunnel`)
  tunnel.kill('SIGINT')
  process.exit(code ?? 1)
})
// If cloudflared dies, the shared URL is dead — never keep running as if live.
tunnel.on('exit', (code) => {
  if (shuttingDown) return
  shuttingDown = true
  console.error(`tunnel exited (${code}) — the shared URL is DEAD. Restart with: npm run share`)
  server.kill('SIGINT')
  process.exit(1)
})
tunnel.on('error', (err) => {
  if (shuttingDown) return
  shuttingDown = true
  console.error(`tunnel failed to start: ${err.message}`)
  server.kill('SIGINT')
  process.exit(1)
})
