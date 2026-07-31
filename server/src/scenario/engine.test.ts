import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DRILL_UID_PREFIX, isForeignSimUid } from '../sim/ns.js'
import type { IcsShape } from '../types.js'
import { ScenarioEngine, type EngineDeps } from './engine.js'

// Behavioral coverage for per-stack drill namespacing, run against the real
// bundled scenario (pabt-drill ships uid-less spawns and fixed DRILL-* shape
// ids — exactly the two normalization paths).

function makeHarness() {
  const published: string[] = []
  const removed: { uid: string; tombstone?: boolean }[] = []
  const shapes = new Map<string, IcsShape>()
  const deps: EngineDeps = {
    publishCot: (xml) => {
      published.push(xml)
      return true
    },
    broadcast: () => {},
    emitTimeline: () => {},
    createIncident: () => {},
    upsertShape: (s) => {
      shapes.set(s.id, s)
    },
    removeShape: (id) => shapes.delete(id),
    removeUnit: (uid, opts) => {
      removed.push({ uid, tombstone: opts?.tombstone })
    },
    setAlarm: () => {},
  }
  return { engine: new ScenarioEngine(deps), published, removed, shapes }
}

/** Event uids of every published UNIT CoT (a-* atoms; shape CoT is u-d-*). */
function unitUids(published: string[]): Set<string> {
  const uids = new Set<string>()
  for (const xml of published) {
    if (!xml.includes('type="a-')) continue
    const m = /uid="([^"]+)"/.exec(xml)
    if (m) uids.add(m[1])
  }
  return uids
}

test('drill unit uids and shape ids are namespaced and survive our own ingest filter', async () => {
  const { engine, published, shapes } = makeHarness()
  await engine.load('pabt-drill')
  engine.seekTo(600) // past the first alarm and six annotations

  const uids = unitUids(published)
  assert.ok(uids.size >= 7, `expected a spawned fleet, saw ${uids.size} uids`)
  for (const uid of uids) {
    assert.ok(uid.startsWith(DRILL_UID_PREFIX), `unit uid not namespaced: ${uid}`)
    // The regression that would empty the drill board: our own TAK echo
    // reading as a foreign stack's traffic.
    assert.equal(isForeignSimUid(uid), false, `own drill uid dropped as foreign: ${uid}`)
  }
  assert.ok(uids.has(`${DRILL_UID_PREFIX}PAPD-21`), 'uid-less spawn not built from callsign')

  assert.ok(shapes.size >= 6, `expected the drill annotations, saw ${shapes.size}`)
  for (const id of shapes.keys()) {
    assert.ok(id.startsWith(DRILL_UID_PREFIX), `shape id not namespaced: ${id}`)
  }
  assert.ok(shapes.has(`${DRILL_UID_PREFIX}STAGING`), 'fixed DRILL-STAGING id not re-homed')

  engine.stop()
  assert.equal(shapes.size, 0, 'stop() must delete every namespaced shape it created')
})

test('stop() despawns exactly the namespaced uids it spawned', async () => {
  const { engine, published, removed } = makeHarness()
  await engine.load('pabt-drill')
  engine.seekTo(60) // seven first-alarm spawns
  const spawned = unitUids(published)
  assert.ok(spawned.size >= 7)

  engine.stop()
  assert.deepEqual(new Set(removed.map((r) => r.uid)), spawned)
  for (const r of removed) {
    assert.equal(r.tombstone, true, `${r.uid}: full teardown must tombstone the TAK echo`)
  }
})

test('rewind skips tombstones for exactly the units it is about to respawn', async () => {
  const { engine, published, removed } = makeHarness()
  await engine.load('pabt-drill')
  engine.seekTo(60)
  const spawned = unitUids(published)
  removed.length = 0

  engine.seekTo(10) // backward: only the two t=2 PAPD posts respawn
  const noTombstone = new Set(removed.filter((r) => r.tombstone === false).map((r) => r.uid))
  const tombstoned = new Set(removed.filter((r) => r.tombstone === true).map((r) => r.uid))
  assert.deepEqual(
    noTombstone,
    new Set([`${DRILL_UID_PREFIX}PAPD-21`, `${DRILL_UID_PREFIX}PAPD-14`]),
    'respawn set must match the namespaced uids or rewound units ghost/tombstone wrongly',
  )
  assert.equal(noTombstone.size + tombstoned.size, spawned.size, 'rewind must despawn the whole board')
  engine.stop()
})
