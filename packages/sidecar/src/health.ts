import type { Client, Integration } from '@moecorp/moelog-core'
import { writeExitMarker, writePendingMarker } from './markers.ts'
import type { Paths } from './paths.ts'
import type { SidecarTransport } from './transport.ts'

export interface ProcessHealthOptions {
  paths: Paths
  app: string
  transport: SidecarTransport
  /** Heartbeat period. The sidecar declares a block after 3 missed beats. */
  hbMs: number
  /** Intercept SIGINT/SIGTERM to report before dying. The signal is re-raised. */
  handleSignals: boolean
  shutdownGraceMs: number
}

const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

/** `process.memoryUsage.rss` is not everywhere; never break over a metric. */
function rss(): number {
  try {
    return Math.round(process.memoryUsage.rss() / 1048576)
  } catch {
    return 0
  }
}

/**
 * Process health: heartbeat, event-loop lag and exit notice.
 *
 * The heartbeat is what lets the sidecar tell apart three things that look
 * identical from the outside: the app finished cleanly, the app exploded, or
 * the app is alive but its event loop is blocked.
 */
export const processHealth = (o: ProcessHealthOptions): Integration => {
  let timer: NodeJS.Timeout | null = null
  let onExit: ((code: number) => void) | null = null
  const signalHandlers = new Map<NodeJS.Signals, () => void>()

  return {
    name: 'processHealth',
    setup(client: Client) {
      let expected = Date.now() + o.hbMs

      timer = setInterval(() => {
        const now = Date.now()
        // If the timer fires late, the event loop was busy for that long.
        const lagMs = Math.max(0, now - expected)
        expected = now + o.hbMs
        o.transport.control({ k: 'hb', t: now, lagMs, rssMb: rss() })
      }, o.hbMs)
      // unref: the heartbeat must never stop the user's app from exiting.
      timer.unref()

      // The code arrives as an argument: `process.exitCode` can still be
      // undefined while the process is exiting with 1 (after an uncaught
      // exception, for instance), which would make a death look like a clean exit.
      onExit = (code: number) => {
        // Whatever is left in the buffer will never make it through the socket:
        // the flush timer is unref'd (so it does not hold the app open) and
        // there is no event loop left to run it. Dump it to disk instead; the
        // sidecar picks it up.
        try {
          const pending = client.drainSync()
          if (pending) writePendingMarker(o.paths, process.pid, pending)
        } catch {
          /* silence */
        }
        writeExitMarker(o.paths, {
          pid: process.pid,
          app: o.app,
          code: code ?? process.exitCode ?? 0,
          signal: null,
          t: Date.now(),
        })
      }
      process.on('exit', onExit)

      if (o.handleSignals) {
        for (const sig of SIGNALS) {
          const h = (): void => {
            writeExitMarker(o.paths, { pid: process.pid, app: o.app, code: null, signal: sig, t: Date.now() })
            o.transport.control({ k: 'bye', code: null, signal: sig })
            process.off(sig, h)
            signalHandlers.delete(sig)
            // Re-raise the signal: the app dies exactly as it would have died
            // without us. We only borrow a few milliseconds to report.
            setTimeout(() => process.kill(process.pid, sig), o.shutdownGraceMs)
          }
          signalHandlers.set(sig, h)
          process.on(sig, h)
        }
      }
    },
    teardown() {
      if (timer) clearInterval(timer)
      timer = null
      if (onExit) process.off('exit', onExit)
      onExit = null
      for (const [sig, h] of signalHandlers) process.off(sig, h)
      signalHandlers.clear()
    },
  }
}
