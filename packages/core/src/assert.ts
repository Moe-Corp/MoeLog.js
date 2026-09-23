/**
 * Development-only validation — the deliberate alternative to zod, valibot or
 * TypeBox. Those cost more than this SDK's entire byte budget; these assertions
 * cost nothing in a production build, because they are stripped from it.
 *
 * `__DEV__` is injected by the bundler. The browser production build defines it
 * as the literal `false`, so `DEV` folds to `false` and this whole file is
 * removed by dead-code elimination: zero bytes in the end user's bundle.
 *
 * When nobody defines it (the Node build, or running the TypeScript directly)
 * the assertions stay on. They cost a single call inside `init()` and they
 * catch configuration mistakes that would otherwise surface as "nothing ever
 * arrives".
 */
import type { Config } from './types.ts'

declare const __DEV__: boolean | undefined

const DEV: boolean = typeof __DEV__ === 'undefined' ? true : __DEV__

const fail = (msg: string): never => {
  throw new TypeError(`[moelog] ${msg}`)
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Runs exactly once, inside `init()`. Never on the hot path. */
export function assertConfig(c: unknown): asserts c is Config {
  if (!DEV) return
  if (typeof c !== 'object' || c === null) fail('init() expects a configuration object')
  const o = c as Record<string, unknown>

  for (const k of ['app', 'release', 'env'] as const) {
    if (o[k] !== undefined && typeof o[k] !== 'string') fail(`${k} must be a string, got ${typeof o[k]}`)
  }
  for (const k of ['sampleRate', 'errorSampleRate'] as const) {
    const v = o[k]
    if (v === undefined) continue
    if (!isNum(v) || v < 0 || v > 1) fail(`${k} must be a number between 0 and 1, got ${String(v)}`)
  }
  for (const k of ['maxBuffer', 'flushAt', 'flushIntervalMs', 'dedupeWindowMs'] as const) {
    const v = o[k]
    if (v === undefined) continue
    if (!isNum(v) || v < 0) fail(`${k} must be a number >= 0, got ${String(v)}`)
  }
  if (isNum(o['flushAt']) && isNum(o['maxBuffer']) && o['flushAt'] > o['maxBuffer']) {
    fail(`flushAt (${o['flushAt']}) cannot exceed maxBuffer (${o['maxBuffer']}): the buffer would drop events before sending them`)
  }
  if (o['beforeSend'] !== undefined && typeof o['beforeSend'] !== 'function') {
    fail('beforeSend must be a function')
  }
  if (o['integrations'] !== undefined) {
    if (!Array.isArray(o['integrations'])) fail('integrations must be an array')
    for (const i of o['integrations'] as unknown[]) {
      const it = i as { name?: unknown; setup?: unknown }
      if (typeof it?.name !== 'string' || typeof it?.setup !== 'function') {
        fail('every integration must be { name: string, setup(client) }')
      }
    }
  }
}

/**
 * Non-fatal warning: the SDK never breaks the host application (principle 4).
 *
 * It depends only on the explicit `debug` flag, never on NODE_ENV. An SDK that
 * decides on its own when to pollute production logs is an SDK people end up
 * ripping out.
 */
export function warn(debug: boolean, msg: string, extra?: unknown): void {
  if (!debug) return
  try {
    console.warn(`[moelog] ${msg}`, extra ?? '')
  } catch {
    /* not even console is guaranteed to exist */
  }
}
