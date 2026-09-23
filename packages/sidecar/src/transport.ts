import net from 'node:net'
import type { Envelope, Transport, TransportResult } from '@moecorp/moelog-core'
import { spawnDaemon, type RuntimeResolver } from './daemon/launch.ts'
import { encode, type ClientMsg, type Hello } from './protocol.ts'
import type { Paths } from './paths.ts'

export interface SidecarOptions {
  paths: Paths
  hello: Omit<Hello, 'k'>
  /** Launch the daemon if nobody is listening. */
  autostart: boolean
  debug: boolean
  /** Cap on messages held while there is no connection. */
  queueLimit: number
  /** Which binary to launch the sidecar with. Supplied by the runtime SDK. */
  runtime?: RuntimeResolver
  /** Where the sidecar forwards to, if there is a server. */
  server?: string
  key?: string
}

export interface SidecarTransport extends Transport {
  /** Control messages (hb, bye, alert) that are not event batches. */
  control(m: ClientMsg): void
  connected(): boolean
}

/**
 * Transport to the sidecar.
 *
 * The application NEVER touches the network: it writes to a local socket and
 * forgets. Retries, durability and (in the future) uploading to the server all
 * happen in the daemon. That is the whole reason this design exists: the cost
 * inside the user's process is one socket write, and durability survives the
 * application's death.
 */
export function createSidecarTransport(o: SidecarOptions): SidecarTransport {
  const log = (m: string, e?: unknown): void => {
    if (o.debug) console.warn(`[moelog:sidecar] ${m}`, e ?? '')
  }

  let sock: net.Socket | null = null
  let connecting = false
  let closed = false
  let attempts = 0
  const queue: string[] = []

  function enqueue(line: string): boolean {
    if (queue.length >= o.queueLimit) {
      queue.shift() // prefer losing the old: the recent error matters more
      queue.push(line)
      return false
    }
    queue.push(line)
    return true
  }

  function drainQueue(): void {
    if (!sock || sock.destroyed) return
    while (queue.length > 0) {
      const line = queue.shift()!
      if (!sock.write(line)) break // backpressure: the rest goes out on 'drain'
    }
  }

  function connect(): void {
    if (closed || connecting || (sock && !sock.destroyed)) return
    connecting = true

    const s = net.createConnection({ path: o.paths.sock })
    // Critical: the socket must not keep the user's application alive.
    s.unref()
    s.setNoDelay(true)

    s.on('connect', () => {
      connecting = false
      attempts = 0
      sock = s
      s.write(encode({ k: 'hello', ...o.hello }))
      drainQueue()
      log('connected')
    })
    s.on('drain', drainQueue)
    s.on('error', (err) => {
      connecting = false
      s.destroy()
      if (sock === s) sock = null
      log('socket error', (err as NodeJS.ErrnoException).code)
      if (o.autostart && attempts === 0) startDaemon()
      scheduleReconnect()
    })
    s.on('close', () => {
      connecting = false
      if (sock === s) sock = null
      scheduleReconnect()
    })
  }

  function scheduleReconnect(): void {
    if (closed) return
    attempts++
    if (attempts > 12) return // the daemon is not coming; stop insisting
    const delay = Math.min(100 * 2 ** Math.min(attempts, 6), 5000)
    setTimeout(connect, delay).unref()
  }

  function startDaemon(): void {
    // Note: if a sidecar is already alive with a different configuration these
    // arguments will not reach it. Run `moelog stop` and start again to re-point it.
    const r = spawnDaemon(o.paths, {
      ...(o.runtime ? { runtime: o.runtime } : {}),
      ...(o.server ? { server: o.server } : {}),
      ...(o.key ? { key: o.key } : {}),
    })
    log(r.spawned ? 'daemon launched' : `daemon not launched: ${r.reason}`)
  }

  function write(m: ClientMsg): boolean {
    if (closed) return false
    const line = encode(m)
    if (sock && !sock.destroyed && sock.writable) {
      sock.write(line)
      return true
    }
    const kept = enqueue(line)
    connect()
    return kept
  }

  // Connect immediately, not on the first event.
  //
  // With lazy connection an app that dies after 200 ms never gets to introduce
  // itself, and the sidecar cannot report a death it never saw begin. Worse,
  // opening the socket needs the event loop: if we wait for the first heartbeat
  // and the loop is already blocked by then, the handshake queues up behind the
  // very block we wanted to detect.
  connect()

  return {
    name: 'sidecar',
    connected: () => sock !== null && !sock.destroyed,
    control: (m) => {
      write(m)
    },
    async send(env: Envelope): Promise<TransportResult> {
      const kept = write({ k: 'batch', env })
      // `retry: false` on purpose: the core buffer must not retry, because the
      // durability queue lives in the sidecar.
      return kept ? { ok: true } : { ok: false, retry: false, reason: 'local queue full' }
    },
    async close(): Promise<void> {
      closed = true
      if (sock && !sock.destroyed) {
        sock.ref() // let the last write go out before we die
        await new Promise<void>((resolve) => {
          sock!.end(() => resolve())
          setTimeout(resolve, 200).unref()
        })
      }
      sock?.destroy()
      sock = null
    },
  }
}
