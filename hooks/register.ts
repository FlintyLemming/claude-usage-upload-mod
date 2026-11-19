import type { EngineInterface, PluginOptions, Register, SessionRateLimit } from 'claude-code'

/** One window as the dashboard's `type: claude` push body takes it. */
type Window = { utilization: number; resets_at: string }

/** The latest reading any session saw, shared through `$.store`. */
type Reading = { five_hour: Window; seven_day: Window; observedAt: number }

/** The last body a session pushed successfully, and when. */
type PushRecord = { at: number; body: string }

/** Where and how to push, read once from the mod's options. */
type Target = { url: string; token: string; isConfigured: boolean }

const READING_KEY = 'latestReading'
const LAST_PUSH_KEY = 'lastPush'

/** How often each session re-sends the latest reading, so the card stays on the dashboard. */
const HEARTBEAT_MS = 5 * 60_000
/** An unchanged body is not re-sent sooner than this, whichever session pushed it last. */
const MIN_RESEND_MS = HEARTBEAT_MS - 30_000

/**
 * Only a change of outcome is logged, so a dashboard that is down does not
 * print a line every five minutes. Starts over when the module reloads.
 */
let lastOutcome: string | undefined

function isWindow(value: unknown): value is Window {
  if (typeof value !== 'object' || value === null) return false
  const w = value as Record<string, unknown>
  return typeof w.utilization === 'number' && typeof w.resets_at === 'string'
}

function isReading(value: unknown): value is Reading {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return isWindow(r.five_hour) && isWindow(r.seven_day) && typeof r.observedAt === 'number'
}

function isPushRecord(value: unknown): value is PushRecord {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Record<string, unknown>
  return typeof p.at === 'number' && typeof p.body === 'string'
}

function targetOf(options: PluginOptions): Target {
  const endpoint = String(options.endpoint ?? '').replace(/\/+$/, '')
  const instanceId = String(options.instanceId ?? '')
  const token = String(options.token ?? '')
  return {
    url: `${endpoint}/api/push/v2/${encodeURIComponent(instanceId)}`,
    token,
    isConfigured: endpoint !== '' && instanceId !== '' && token !== '',
  }
}

/**
 * Reads one window out of the engine's rate limits. A reading without its own
 * reset time borrows the previous one while that is still ahead.
 */
function windowOf(
  limits: readonly SessionRateLimit[],
  kind: 'five_hour' | 'seven_day',
  previous: Window | undefined,
  now: number,
): Window | undefined {
  const limit = limits.find(l => l.kind === kind)
  if (limit === undefined) return undefined
  const resetsAt =
    limit.resetsAt ??
    (previous !== undefined && Date.parse(previous.resets_at) > now ? previous.resets_at : undefined)
  return resetsAt === undefined ? undefined : { utilization: limit.percentUsed, resets_at: resetsAt }
}

/** A window whose reset time has passed has started over: report it as unused. */
function current(w: Window, now: number): Window {
  return Date.parse(w.resets_at) <= now ? { ...w, utilization: 0 } : w
}

function report($: EngineInterface, outcome: string, line: string): void {
  if (outcome === lastOutcome) return
  lastOutcome = outcome
  $.ui.log(`${$.plugin.name}: ${line}`)
}

/** Sends the latest stored reading, unless the same body went out recently. */
async function push($: EngineInterface, target: Target): Promise<void> {
  if (!target.isConfigured) {
    report($, 'unconfigured', 'set endpoint, instanceId and token in pluginConfigs to start uploading')
    return
  }
  const stored = await $.store.get(READING_KEY)
  if (!isReading(stored)) return

  const now = await $.clock.now()
  const body = JSON.stringify({
    five_hour: current(stored.five_hour, now),
    seven_day: current(stored.seven_day, now),
  })
  const last = await $.store.get(LAST_PUSH_KEY)
  if (isPushRecord(last) && last.body === body && now - last.at < MIN_RESEND_MS) return

  try {
    const res = await $.http.fetch(target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.token}` },
      body,
    })
    if (res.ok) {
      await $.store.set(LAST_PUSH_KEY, { at: now, body } satisfies PushRecord)
      report($, 'ok', `uploading rate limits to ${target.url}`)
    } else {
      report($, `http ${res.status}`, `upload refused: HTTP ${res.status} ${res.text.slice(0, 200)}`)
    }
  } catch (error) {
    report($, 'error', `upload failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Keeps the session's newest 5-hour and 7-day readings, then pushes them. */
async function record(
  $: EngineInterface,
  limits: readonly SessionRateLimit[],
  target: Target,
): Promise<void> {
  const now = await $.clock.now()
  const stored = await $.store.get(READING_KEY)
  const previous = isReading(stored) ? stored : undefined
  const fiveHour = windowOf(limits, 'five_hour', previous?.five_hour, now)
  const sevenDay = windowOf(limits, 'seven_day', previous?.seven_day, now)
  if (fiveHour === undefined || sevenDay === undefined) return

  await $.store.set(READING_KEY, {
    five_hour: fiveHour,
    seven_day: sevenDay,
    observedAt: now,
  } satisfies Reading)
  await push($, target)
}

export const register: Register = (on, options) => {
  const target = targetOf(options)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // Timers stop when the module reloads, and a reload runs session.start again.
    $.clock.every(HEARTBEAT_MS, () => {
      void push($, target)
    })
    await push($, target)
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await record($, e.rateLimits, target)
    return result
  })
}
