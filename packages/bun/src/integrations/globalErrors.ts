import { LEVEL, TYPE, type Client, type Integration } from '@moecorp/moelog-core'
import { writeCrashMarker, type Paths } from '@moecorp/moelog-sidecar'

/**
 * What to do with unhandled promise rejections, **on Bun**.
 *
 *  - 'capture' (the default) registers the listener. On Bun it is the only way
 *    to find out: an unhandled rejection is printed and the process stays alive
 *    with exit code 0, so `uncaughtExceptionMonitor` never hears about it.
 *    Since Bun was not going to die anyway, registering does not change the
 *    process's fate — it only silences its message, which we reprint.
 *  - 'off' registers nothing. You stay blind to rejections.
 *
 * This is the opposite of Node, where the right move is to register NOTHING.
 * That difference is not an implementation detail: it is the reason these two
 * SDKs are separate packages.
 */
export type RejectionMode = 'capture' | 'off'

export interface GlobalErrorsOptions {
  paths: Paths
  app: string
  mode?: RejectionMode
}

/**
 * Unhandled error capture on Bun.
 *
 * `uncaughtExceptionMonitor` does work on Bun for exceptions (verified on 1.4):
 * it observes without hijacking, exactly as on Node.
 */
export const globalErrors = (o: GlobalErrorsOptions): Integration => {
  const mode = o.mode ?? 'capture'
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

      if (mode === 'off') return

      onRejection = (reason: unknown) => {
        if (typeof reason === 'object' && reason !== null) {
          if (captured.has(reason)) return
          captured.add(reason)
        }
        client.capture(TYPE.error, LEVEL.error, reason, { unhandledRejection: true })
        // Registering the listener silences the message Bun was about to print.
        // Give it back: we are not taking information away from anyone.
        try {
          console.error('Unhandled rejection:', reason)
        } catch {
          /* silence */
        }
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
