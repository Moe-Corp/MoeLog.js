import { createClient, LEVEL, TYPE } from '@moecorp/moelog-core'
import type { Client, Config, Integration, Level, LevelName } from '@moecorp/moelog-core'
import type { RuntimeResolver } from './daemon/launch.ts'
import { processHealth } from './health.ts'
import { resolvePaths, type Paths } from './paths.ts'
import { createSidecarTransport } from './transport.ts'

/**
 * Per-runtime SDK factory.
 *
 * Everything that does NOT depend on the runtime lives here: the client, the
 * sidecar transport, the heartbeat, the public API. Each runtime package
 * supplies only what Node, Bun or Deno genuinely do differently — which is not
 * much, but it is exactly the part that cannot be decided generically without
 * lying to one of them.
 */

export interface SdkOptions extends Config {
  /** Where the sidecar and its files live. Defaults to `<cwd>/.moelog`. */
  dataDir?: string
  /** Launch the sidecar automatically if none is running. */
  autostart?: boolean
  /**
   * MoeLog server URL. Without it the sidecar keeps the local NDJSON only.
   * Can also be set through the environment: MOELOG_SERVER / MOELOG_KEY.
   *
   * Your application never talks to this URL: it hands it to the sidecar and
   * forgets about it.
   */
  server?: string
  key?: string
  /** Install the runtime's unhandled-error capture. */
  captureGlobals?: boolean
  /** Heartbeat period. The sidecar declares a block after 3 missed beats. */
  hbMs?: number
  /** Report before dying on SIGINT/SIGTERM. The signal is re-raised. */
  handleSignals?: boolean
  shutdownGraceMs?: number
}

export interface RuntimeAdapter<O extends SdkOptions = SdkOptions> {
  /** Identifier carried in every envelope, e.g. `js-node/0.0.2-alpha.1`. */
  sdk: string
  /** Runtime tag, e.g. `node/24.21.0`. */
  runtimeTag(): string
  /** Which binary to launch the sidecar with. */
  daemonRuntime: RuntimeResolver
  /** Runtime-specific integrations (global error capture, and so on). */
  integrations(ctx: { paths: Paths; app: string; options: O }): Integration[]
}

export interface Sdk<O extends SdkOptions = SdkOptions> {
  init(options?: O): Client
  getClient(): Client | null
  log(level: LevelName, msg: string, ctx?: Record<string, unknown>): void
  error(err: unknown, ctx?: Record<string, unknown>): void
  fatal(err: unknown, ctx?: Record<string, unknown>): void
  event(name: string, ctx?: Record<string, unknown>): void
  flush(): Promise<void>
  close(): Promise<void>
}

export function defineSdk<O extends SdkOptions>(adapter: RuntimeAdapter<O>): Sdk<O> {
  let current: Client | null = null

  /** Idempotent per process: a second call does not duplicate handlers. */
  function init(options: O = {} as O): Client {
    if (current) return current

    const paths = resolvePaths(options.dataDir)
    const app = options.app ?? process.env['MOELOG_APP'] ?? 'app'
    const hbMs = options.hbMs ?? 2000

    const transport = createSidecarTransport({
      paths,
      autostart: options.autostart ?? true,
      debug: options.debug ?? false,
      queueLimit: 500,
      runtime: adapter.daemonRuntime,
      ...(options.server ?? process.env['MOELOG_SERVER']
        ? { server: options.server ?? process.env['MOELOG_SERVER']! }
        : {}),
      ...(options.key ?? process.env['MOELOG_KEY']
        ? { key: options.key ?? process.env['MOELOG_KEY']! }
        : {}),
      hello: {
        pid: process.pid,
        rt: adapter.runtimeTag(),
        app,
        sdk: adapter.sdk,
        role: 'app',
        cwd: process.cwd(),
        hbMs,
      },
    })

    const integrations: Integration[] = [
      processHealth({
        paths,
        app,
        transport,
        hbMs,
        handleSignals: options.handleSignals ?? true,
        shutdownGraceMs: options.shutdownGraceMs ?? 60,
      }),
      ...(options.captureGlobals === false ? [] : adapter.integrations({ paths, app, options })),
      ...(options.integrations ?? []),
    ]

    current = createClient(
      { ...options, app, integrations },
      {
        transport,
        sdk: adapter.sdk,
        runtime: adapter.runtimeTag(),
        // unref'd timers: the SDK never keeps the user's process alive.
        schedule: (fn, ms) => {
          const t = setTimeout(fn, ms)
          t.unref()
          return () => clearTimeout(t)
        },
      },
    )

    return current
  }

  /** Auto-init: using the SDK without calling init() should not lose events. */
  const need = (): Client | null => {
    if (!current && process.env['MOELOG_AUTOINIT'] !== '0') return init()
    return current
  }

  return {
    init,
    getClient: () => current,
    error: (err, ctx) => need()?.capture(TYPE.error, LEVEL.error, err, ctx),
    fatal: (err, ctx) => need()?.capture(TYPE.error, LEVEL.fatal, err, ctx),
    log: (level, msg, ctx) => need()?.capture(TYPE.log, LEVEL[level] as Level, msg, ctx),
    event: (name, ctx) => need()?.capture(TYPE.event, LEVEL.info, name, ctx),
    flush: () => current?.flush('manual') ?? Promise.resolve(),
    async close() {
      const c = current
      current = null
      await c?.close()
    },
  }
}
