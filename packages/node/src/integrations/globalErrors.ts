import { LEVEL, TYPE, type Client, type Integration } from '@moecorp/moelog-core'
import { writeCrashMarker, type Paths } from '@moecorp/moelog-sidecar'

/**
 * What to do with unhandled promise rejections, **on Node**.
 *
 *  - 'native' (the default) registers nothing. Node already turns an unhandled
 *    rejection into an uncaught exception, and `uncaughtExceptionMonitor` sees
 *    it with a full stack. Registering our own listener would only break that.
 *  - 'observe' registers the listener. It captures the rejection, but doing so
 *    DISABLES the process death: the app survives something that would have
 *    killed it. That is a change to runtime semantics, so it has to be asked for.
 */
export type RejectionMode = 'native' | 'observe'

export interface GlobalErrorsOptions {
  paths: Paths
  app: string
  mode?: RejectionMode
}

/**
 * Unhandled error capture on Node.
 *
 * It uses `uncaughtExceptionMonitor`, not `uncaughtException`: the monitor
 * observes without hijacking. Registering `uncaughtException` would stop Node
 * from dying on a fatal error, and an observability SDK that decides when the
 * user's app lives or dies is a bug, not a feature.
 */
export const globalErrors = (o: GlobalErrorsOptions): Integration => {
  const mode = o.mode ?? 'native'
  let onUncaught: ((err: Error, origin: string) => void) | null = null
  let onRejection: ((reason: unknown) => void) | null = null

  return {
    name: 'globalErrors',
    setup(client: Client) {
      const captured = new WeakSet<object>()

      onUncaught = (err: Error, origin: string) => {
        const dup = typeof err === 'object' && err !== null && captured.has(err)
        if (!dup) {
          if (typeof err === 'object' && err !== null) captured.add(err)
          client.capture(TYPE.error, LEVEL.fatal, err, { origin, fatal: true })
        }
        // The process dies the moment we return: the socket is asynchronous and
        // will not make it. A 200-byte writeFileSync will. This is the only
        // thing that survives with certainty.
        writeCrashMarker(o.paths, {
          pid: process.pid,
          app: o.app,
          name: err?.name ?? 'Error',
          message: err?.message ?? String(err),
          stack: err?.stack ?? null,
          origin,
          t: Date.now(),
        })
      }
      process.on('uncaughtExceptionMonitor', onUncaught)

      if (mode !== 'observe') return

      onRejection = (reason: unknown) => {
        if (typeof reason === 'object' && reason !== null) {
          if (captured.has(reason)) return
          captured.add(reason)
        }
        client.capture(TYPE.error, LEVEL.error, reason, { unhandledRejection: true })
      }
      process.on('unhandledRejection', onRejection)
    },
    teardown() {
      if (onUncaught) process.off('uncaughtExceptionMonitor', onUncaught)
      if (onRejection) process.off('unhandledRejection', onRejection)
      onUncaught = onRejection = null
    },
  }
}
