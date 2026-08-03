import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  allFeedHealth,
  clearAllFeedMocks,
  feedData,
  feedHealth,
  registerFeed,
  resetFeedsForTest,
  setFeedMock,
  startFeeds,
} from './registry.js'
import { BudgetExhausted, declareBudget, resetSchedulerForTest } from './scheduler.js'
import type { FeedAdapter, FeedContext } from './types.js'

// Prompt 13 M0 regression coverage: the disciplines the whole feed layer
// promises — per-feed degradation, honest staleness, mock injection for
// keyless demos, unconfigured parking for missing keys, and rate budgets.

afterEach(() => {
  resetFeedsForTest()
  resetSchedulerForTest()
})

function makeAdapter(overrides: Partial<FeedAdapter> & { poll?: FeedAdapter['poll'] } = {}): FeedAdapter {
  return {
    id: 'test-feed',
    capabilityId: 'feeds.test',
    name: 'Test Feed',
    profiles: 'both',
    attribution: 'TEST',
    refreshIntervalMs: 50,
    poll: async () => ({ n: 1 }),
    ...overrides,
  }
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('successful poll serves data, broadcasts it, and health reads ok', async () => {
  const msgs: unknown[] = []
  registerFeed(makeAdapter())
  startFeeds((m) => msgs.push(m))
  await tick(30)
  const h = feedHealth('test-feed')!
  assert.equal(h.status, 'ok')
  assert.ok(h.lastSuccess !== null)
  assert.deepEqual(feedData('test-feed')!.payload, { n: 1 })
  assert.ok(msgs.some((m) => (m as { type: string }).type === 'feed.data'))
  assert.ok(msgs.some((m) => (m as { type: string }).type === 'feed.health'))
})

test('a failing adapter degrades only itself and backs off; others keep serving', async () => {
  registerFeed(makeAdapter({ id: 'bad', poll: async () => Promise.reject(new Error('upstream 500')) }))
  registerFeed(makeAdapter({ id: 'good' }))
  startFeeds(() => {})
  await tick(700) // staggered start (400ms) + first polls
  const bad = feedHealth('bad')!
  const good = feedHealth('good')!
  assert.equal(good.status, 'ok', 'healthy feed unaffected')
  assert.equal(bad.status, 'down')
  assert.ok(bad.consecutiveFails >= 1)
  assert.equal(bad.lastError, 'upstream 500')
  assert.equal(feedData('bad'), null, 'no data ever served from a feed that never succeeded')
})

test('missing required env parks the adapter as unconfigured and it never polls', async () => {
  let polled = 0
  registerFeed(
    makeAdapter({
      id: 'keyed',
      requiredEnv: ['DEFINITELY_NOT_SET_XYZ'],
      signupUrl: 'https://example.com/signup',
      poll: async () => {
        polled++
        return {}
      },
    }),
  )
  startFeeds(() => {})
  await tick(30)
  const h = feedHealth('keyed')!
  assert.equal(h.status, 'unconfigured')
  assert.deepEqual(h.missingEnv, ['DEFINITELY_NOT_SET_XYZ'])
  assert.equal(h.signupUrl, 'https://example.com/signup')
  assert.equal(polled, 0)
})

test('mock injection suspends the live loop, serves flagged data, and clears back to live', async () => {
  let polled = 0
  registerFeed(
    makeAdapter({
      poll: async () => {
        polled++
        return { live: true }
      },
    }),
  )
  startFeeds(() => {})
  await tick(30)
  const before = polled
  assert.ok(setFeedMock('test-feed', { depthIn: 4.2 }))
  assert.equal(feedHealth('test-feed')!.status, 'mock')
  const served = feedData('test-feed')!
  assert.equal(served.mock, true)
  assert.deepEqual(served.payload, { depthIn: 4.2 })
  assert.match(served.attribution, /SIMULATED/)
  await tick(180) // several refresh intervals — live loop must stay parked
  assert.equal(polled, before, 'no live polls while mocked')
  clearAllFeedMocks()
  await tick(320) // resume poll fires ~250ms after clearing
  assert.ok(polled > before, 'live polling resumes after mock clears')
  assert.equal(feedData('test-feed')!.mock, false)
})

test('unknown feed mock returns false; health list covers every registered feed', async () => {
  registerFeed(makeAdapter({ id: 'a' }))
  registerFeed(makeAdapter({ id: 'b' }))
  assert.equal(setFeedMock('nope', {}), false)
  assert.deepEqual(
    allFeedHealth()
      .map((h) => h.id)
      .sort(),
    ['a', 'b'],
  )
})

test('rate budget: calls beyond the window throw BudgetExhausted and recover after the window', async () => {
  declareBudget('tight', 2, 120)
  const { feedContext } = await import('./scheduler.js')
  // Point at a URL that will never be reached: budget is drawn BEFORE fetch,
  // so the third call must throw BudgetExhausted (not a network error).
  const url = 'http://127.0.0.1:1/unreachable'
  const opts = { budgetKey: 'tight', timeoutMs: 300 }
  await assert.rejects(feedContext.fetchJson(url, opts), (e: Error) => e.name !== 'BudgetExhausted')
  await assert.rejects(feedContext.fetchJson(url, opts), (e: Error) => e.name !== 'BudgetExhausted')
  await assert.rejects(feedContext.fetchJson(url, opts), (e: Error) => e instanceof BudgetExhausted)
  await tick(140)
  await assert.rejects(feedContext.fetchJson(url, opts), (e: Error) => e.name !== 'BudgetExhausted')
})
