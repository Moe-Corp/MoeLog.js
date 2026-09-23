/**
 * Microkernel contracts. Everything here is types-only or constants: it touches
 * no environment API (no DOM, no node:*), so the same core runs in the browser,
 * Node, Bun, Deno and edge runtimes.
 */

/** MLWP severities. Numeric so comparing and ordering stays O(1). */
export const LEVEL = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const
export type Level = (typeof LEVEL)[keyof typeof LEVEL]
export type LevelName = keyof typeof LEVEL

/** MLWP event types. */
export const TYPE = { log: 0, error: 1, event: 2, span: 3 } as const
export type EventType = (typeof TYPE)[keyof typeof TYPE]

/** A parsed stack frame. On the wire it travels as a positional tuple. */
export interface Frame {
  file: string
  line: number
  col: number
  fn: string
}

/**
 * An in-memory event. Note that `raw` holds the *unparsed* Error: parsing a
 * stack is the expensive part, and it happens on the deferred path, never at
 * capture time.
 */
export interface MoeEvent {
  type: EventType
  t: number
  level: Level
  msg: string
  ctx?: Record<string, unknown>
  fp?: string
  frames?: Frame[]
  raw?: unknown
}

/** Batch-wide context: sent once per envelope, not once per event. */
export interface AppContext {
  app: string
  rel?: string
  env?: string
  rt?: string
  [k: string]: unknown
}

export type WireFrame = [file: string, line: number, col: number, fn: string]
export type WireEvent = [
  type: EventType,
  dt: number,
  level: Level,
  msg: string,
  ctx: Record<string, unknown> | null,
  fp: string | null,
  frames?: WireFrame[],
]

/** MLWP v1 envelope: the only thing that crosses the process boundary. */
export interface Envelope {
  v: 1
  sdk: string
  t: number
  ctx: AppContext
  e: WireEvent[]
}

export type TransportResult =
  | { ok: true }
  | { ok: false; retry: boolean; reason?: string }

/** A transport only knows how to push bytes. It does not decide retry policy. */
export interface Transport {
  name: string
  send(env: Envelope): Promise<TransportResult>
  close?(): Promise<void>
}

/** A vertical slice: it hooks into the pipeline and cleans up after itself. */
export interface Integration {
  name: string
  setup(client: Client): void
  teardown?(): void
}

export interface Hooks {
  /** Synchronous and on the hot path. Returning null drops the event. */
  onCapture: (e: MoeEvent) => MoeEvent | null
  /** Deferred phase: the stack has already been parsed. */
  beforeSend: (e: MoeEvent) => MoeEvent | null
  /** Transport outcome, for internal telemetry. */
  onResult: (r: TransportResult, count: number) => void
}
export type HookName = keyof Hooks

export interface Scope {
  app?: string
  release?: string
  env?: string
  tags: Record<string, unknown>
  user?: { id?: string; [k: string]: unknown }
}

export interface Config {
  app?: string
  release?: string
  env?: string
  /** Sampling for logs (0..1). Errors use `errorSampleRate`. */
  sampleRate?: number
  errorSampleRate?: number
  /** Ring buffer capacity. A hard memory bound. */
  maxBuffer?: number
  /** Flush once N events have piled up. */
  flushAt?: number
  /** Flush every N milliseconds. */
  flushIntervalMs?: number
  /**
   * Severity at or above which an event forces an immediate flush.
   *
   * With a local sidecar, batching buys very little, while waiting 5 seconds
   * for the buffer to fill means losing the last thing a dying process said.
   */
  flushOnLevel?: Level
  /** Deduplication window keyed by fingerprint. 0 disables it. */
  dedupeWindowMs?: number
  integrations?: Integration[]
  beforeSend?: (e: MoeEvent) => MoeEvent | null
  debug?: boolean
}

export interface ResolvedConfig extends Required<Omit<Config, 'beforeSend' | 'integrations'>> {
  beforeSend?: (e: MoeEvent) => MoeEvent | null
  integrations: Integration[]
}

export interface Client {
  readonly config: ResolvedConfig
  readonly scope: Scope
  capture(type: EventType, level: Level, input: unknown, ctx?: Record<string, unknown>): void
  on<K extends HookName>(hook: K, fn: Hooks[K]): () => void
  flush(reason?: string): Promise<void>
  /**
   * Drain the buffer and return the envelope without sending it, synchronously.
   * It exists for the one moment when there is no event loop left: the 'exit'
   * handler. The caller is responsible for persisting the result.
   */
  drainSync(): Envelope | null
  close(): Promise<void>
  /** SDK self-diagnostics: never leaves here unless `debug` is on. */
  stats(): { captured: number; dropped: number; sent: number; failed: number; buffered: number }
}

/** Dependencies the core cannot build itself: the environment package supplies them. */
export interface ClientDeps {
  transport: Transport
  /** Schedules deferred work. Node: an unref'd timer. Browser: an idle callback. */
  schedule(fn: () => void, ms: number): () => void
  sdk: string
  runtime: string
}
