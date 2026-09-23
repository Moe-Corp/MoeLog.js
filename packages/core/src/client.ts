import { assertConfig, warn } from './assert.ts'
import { RingBuffer } from './buffer.ts'
import { fingerprintError } from './fingerprint.ts'
import { HookBus } from './hooks.ts'
import { normalizeError } from './stack.ts'
import { toEnvelope } from './serialize.ts'
import { LEVEL, TYPE } from './types.ts'
import type {
  AppContext,
  Client,
  ClientDeps,
  Config,
  Envelope,
  EventType,
  HookName,
  Hooks,
  Level,
  MoeEvent,
  ResolvedConfig,
  Scope,
} from './types.ts'

const DEFAULTS = {
  app: 'app',
  release: '0.0.0',
  env: 'development',
  sampleRate: 1,
  errorSampleRate: 1,
  maxBuffer: 64,
  flushAt: 32,
  flushIntervalMs: 5000,
  flushOnLevel: LEVEL.error,
  dedupeWindowMs: 2000,
  debug: false,
} satisfies Omit<ResolvedConfig, 'integrations' | 'beforeSend'>

export function createClient(config: Config, deps: ClientDeps): Client {
  assertConfig(config)
  const cfg: ResolvedConfig = { ...DEFAULTS, integrations: [], ...config }

  const buffer = new RingBuffer(cfg.maxBuffer)
  const hooks = new HookBus()
  const scope: Scope = {
    app: cfg.app,
    release: cfg.release,
    env: cfg.env,
    tags: {},
  }

  const seen = new Map<string, number>()
  let cancelTimer: (() => void) | null = null
  let inFlight: Promise<void> = Promise.resolve()
  let closed = false
  const stat = { captured: 0, dropped: 0, sent: 0, failed: 0 }

  // ---------------------------------------------------------------- hot path
  function capture(
    type: EventType,
    level: Level,
    input: unknown,
    ctx?: Record<string, unknown>,
  ): void {
    if (closed) return

    const rate = type === TYPE.error ? cfg.errorSampleRate : cfg.sampleRate
    if (rate < 1 && Math.random() >= rate) {
      stat.dropped++
      return
    }

    const now = Date.now()
    let msg: string
    let fp: string | undefined
    let raw: unknown

    if (type === TYPE.error) {
      // No `.stack` access here: that getter is the expensive part, and it is
      // deferred to the flush.
      const isErr = input instanceof Error
      const name = isErr ? input.name || 'Error' : 'NonError'
      msg = isErr ? input.message : typeof input === 'string' ? input : String(input)
      fp = fingerprintError(name, msg)
      raw = input

      if (cfg.dedupeWindowMs > 0) {
        const last = seen.get(fp)
        if (last !== undefined && now - last < cfg.dedupeWindowMs) {
          stat.dropped++
          return
        }
        seen.set(fp, now)
        if (seen.size > 256) seen.clear()
      }
    } else {
      msg = typeof input === 'string' ? input : String(input)
    }

    const ev: MoeEvent = { type, t: now, level, msg }
    if (ctx) ev.ctx = ctx
    if (fp) ev.fp = fp
    if (raw !== undefined) ev.raw = raw

    const filtered = hooks.filter('onCapture', ev)
    if (filtered === null) {
      stat.dropped++
      return
    }

    buffer.push(filtered)
    stat.captured++

    if (filtered.level >= cfg.flushOnLevel || buffer.size >= cfg.flushAt) {
      armTimer(0)
    } else if (!cancelTimer) {
      armTimer(cfg.flushIntervalMs)
    }
  }

  function armTimer(ms: number): void {
    cancelTimer?.()
    cancelTimer = deps.schedule(() => {
      cancelTimer = null
      void flush('timer')
    }, ms)
  }

  // ----------------------------------------------------------- deferred path
  function hydrate(e: MoeEvent): MoeEvent | null {
    if (e.raw !== undefined) {
      const n = normalizeError(e.raw)
      e.msg = n.msg || e.msg
      e.frames = n.frames
      if (!e.ctx?.['name']) e.ctx = { ...e.ctx, name: n.name }
      delete e.raw // never serialize the original Error: it can drag half the world along
    }
    const afterHooks = hooks.filter('beforeSend', e)
    if (afterHooks === null) return null
    return cfg.beforeSend ? cfg.beforeSend(afterHooks) : afterHooks
  }

  function appContext(): AppContext {
    const c: AppContext = { app: scope.app ?? cfg.app, rt: deps.runtime }
    if (scope.release) c.rel = scope.release
    if (scope.env) c.env = scope.env
    if (Object.keys(scope.tags).length > 0) c.tags = scope.tags
    if (scope.user) c.user = scope.user
    return c
  }

  async function doFlush(reason: string): Promise<void> {
    if (buffer.size === 0) return
    const raw = buffer.drain()

    const events: MoeEvent[] = []
    for (const e of raw) {
      let out: MoeEvent | null = null
      try {
        out = hydrate(e)
      } catch (err) {
        warn(cfg.debug, 'beforeSend threw, event dropped', err)
      }
      if (out) events.push(out)
    }
    if (events.length === 0) return

    const env = toEnvelope(events, appContext(), deps.sdk)
    let result
    try {
      result = await deps.transport.send(env)
    } catch (err) {
      result = { ok: false as const, retry: true, reason: String(err) }
    }

    hooks.emitResult(result, events.length)
    if (result.ok) {
      stat.sent += events.length
    } else {
      stat.failed += events.length
      warn(cfg.debug, `transport failed (${reason}): ${result.reason ?? 'no detail'}`)
      if (result.retry) for (const e of events) buffer.push(e)
    }
  }

  function flush(reason = 'manual'): Promise<void> {
    cancelTimer?.()
    cancelTimer = null
    inFlight = inFlight.then(() => doFlush(reason)).catch(() => undefined)
    return inFlight
  }

  const client: Client = {
    config: cfg,
    scope,
    capture,
    on<K extends HookName>(hook: K, fn: Hooks[K]) {
      return hooks.on(hook, fn)
    },
    drainSync(): Envelope | null {
      if (buffer.size === 0) return null
      const events: MoeEvent[] = []
      for (const e of buffer.drain()) {
        try {
          const out = hydrate(e)
          if (out) events.push(out)
        } catch {
          /* a broken beforeSend must not block the dump */
        }
      }
      return events.length > 0 ? toEnvelope(events, appContext(), deps.sdk) : null
    },
    flush,
    async close() {
      if (closed) return
      cancelTimer?.()
      cancelTimer = null
      for (const i of cfg.integrations) {
        try {
          i.teardown?.()
        } catch {
          /* silence */
        }
      }
      await flush('close') // the last flush runs before the door closes
      closed = true
      hooks.clear()
      await deps.transport.close?.()
    },
    stats: () => ({ ...stat, dropped: stat.dropped + buffer.dropped, buffered: buffer.size }),
  }

  for (const integration of cfg.integrations) {
    try {
      integration.setup(client)
    } catch (err) {
      warn(cfg.debug, `integration "${integration.name}" failed during setup`, err)
    }
  }

  return client
}

export { LEVEL, TYPE }
