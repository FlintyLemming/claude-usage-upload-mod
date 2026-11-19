import type { On, SessionRateLimit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const OPTIONS = {
  endpoint: 'https://dash.example/',
  instanceId: 'claude-main',
  token: 'test-token',
} as const

const T0 = Date.parse('2026-11-19T12:00:00Z')

const LIMITS: SessionRateLimit[] = [
  { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-11-19T15:00:00Z' },
  { kind: 'seven_day', percentUsed: 41, resetsAt: '2026-11-24T09:00:00Z' },
]

type Sent = { url: string; headers: Record<string, string>; body: unknown }

/** Stands for the engine beneath the mod: a clock, a store and a dashboard that accepts. */
function engine(on: On) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on)
  const sent: Sent[] = []
  const logs: string[] = []
  on('http.fetch', (_, e) => {
    sent.push({
      url: e.url,
      headers: { ...(e.init?.headers ?? {}) },
      body: typeof e.init?.body === 'string' ? JSON.parse(e.init.body) : null,
    })
    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })
  on('ui.log', (_, e) => {
    logs.push(String(e.text))
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  return { clock, sent, logs }
}

const MEASURE = { context: { window: 200_000 }, changed: ['rateLimits'] as const }

test('a measurement with both windows is pushed to the instance', { options: OPTIONS }, async ($, on) => {
  const { sent } = engine(on)

  await $.session.measure({ ...MEASURE, rateLimits: LIMITS, changed: ['rateLimits'] })

  expect(sent.length).toBe(1)
  expect(sent[0]?.url).toBe('https://dash.example/api/push/v2/claude-main')
  expect(sent[0]?.headers.Authorization).toBe('Bearer test-token')
  expect(sent[0]?.body).toEqual({
    five_hour: { utilization: 23.5, resets_at: '2026-11-19T15:00:00Z' },
    seven_day: { utilization: 41, resets_at: '2026-11-24T09:00:00Z' },
  })
})

test('an unchanged reading waits for the heartbeat; a changed one goes at once', { options: OPTIONS }, async ($, on) => {
  const { clock, sent } = engine(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.measure({ ...MEASURE, rateLimits: LIMITS, changed: ['rateLimits'] })
  expect(sent.length).toBe(1)

  await clock.advance(60_000)
  await $.session.measure({ ...MEASURE, rateLimits: LIMITS, changed: ['rateLimits'] })
  expect(sent.length).toBe(1)

  await clock.advance(4 * 60_000)
  expect(sent.length).toBe(2)

  const moved: SessionRateLimit[] = [{ ...LIMITS[0]!, percentUsed: 30 }, LIMITS[1]!]
  await $.session.measure({ ...MEASURE, rateLimits: moved, changed: ['rateLimits'] })
  expect(sent.length).toBe(3)
  expect(sent[2]?.body).toMatchObject({ five_hour: { utilization: 30 } })
})

test('a window past its reset time is reported as unused', { options: OPTIONS }, async ($, on) => {
  const { clock, sent } = engine(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.measure({ ...MEASURE, rateLimits: LIMITS, changed: ['rateLimits'] })
  await clock.set(Date.parse('2026-11-19T15:01:00Z'))
  await clock.advance(5 * 60_000)

  expect(sent.at(-1)?.body).toEqual({
    five_hour: { utilization: 0, resets_at: '2026-11-19T15:00:00Z' },
    seven_day: { utilization: 41, resets_at: '2026-11-24T09:00:00Z' },
  })
})

test('a reading missing a window is not pushed', { options: OPTIONS }, async ($, on) => {
  const { sent } = engine(on)

  await $.session.measure({ ...MEASURE, rateLimits: [LIMITS[1]!], changed: ['rateLimits'] })

  expect(sent.length).toBe(0)
})

test('without a token nothing is sent and the log says why', { options: { ...OPTIONS, token: '' } }, async ($, on) => {
  const { sent, logs } = engine(on)

  await $.session.measure({ ...MEASURE, rateLimits: LIMITS, changed: ['rateLimits'] })

  expect(sent.length).toBe(0)
  expect(logs.some(l => l.includes('token'))).toBe(true)
})
