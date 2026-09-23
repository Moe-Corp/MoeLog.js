import type { Envelope } from '@moecorp/moelog-core'

/**
 * HTTP sink towards MoeLog server.
 *
 * This is where the sidecar design pays off: the user's application never knew
 * a network existed. Everything below — queueing, retries, backoff, keys, a
 * server that is down — happens in ANOTHER process. If the server is down for
 * an hour, the app does not notice and does not pay a microsecond for it.
 *
 * The local NDJSON keeps being written regardless: it is the backup record and
 * the only thing left if the server never comes to exist.
 */

export interface UpstreamOptions {
  url: string
  key: string
  log: (msg: string) => void
  /** Cap on held requests. Beyond it, the oldest are dropped. */
  limit?: number
}

interface Pending {
  route: string
  body: string
}

export class Upstream {
  private url: string
  private key: string
  private log: (m: string) => void
  private limit: number
  private queue: Pending[] = []
  private timer: NodeJS.Timeout | null = null
  private attempts = 0
  private muted = false
  private closed = false
  sent = 0
  dropped = 0

  constructor(o: UpstreamOptions) {
    this.url = o.url.replace(/\/+$/, '')
    this.key = o.key
    this.log = o.log
    this.limit = o.limit ?? 1000
  }

  get pending(): number {
    return this.queue.length
  }

  get active(): boolean {
    return !this.muted && !this.closed
  }

  /** An MLWP envelope exactly as the SDK sent it. */
  events(env: Envelope, pid: number): void {
    // The pid does not travel in MLWP from the SDK, but the sidecar knows it
    // and it lets the server tell two instances of the same app apart.
    const withPid: Envelope = { ...env, ctx: { ...env.ctx, pid } }
    this.enqueue('/v1/ingest', JSON.stringify(withPid))
  }

  alert(rec: Record<string, unknown>): void {
    this.enqueue('/v1/alerts', JSON.stringify(rec))
  }

  private enqueue(route: string, body: string): void {
    if (!this.active) return
    if (this.queue.length >= this.limit) {
      this.queue.shift()
      this.dropped++
    }
    this.queue.push({ route, body })
    this.schedule(0)
  }

  private schedule(ms: number): void {
    if (this.timer || this.closed) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.pump()
    }, ms)
    // unref: the queue cannot stop the sidecar from shutting down when idle.
    this.timer.unref()
  }

  private async pump(): Promise<void> {
    while (this.queue.length > 0 && this.active) {
      const item = this.queue[0]!
      let res: Response
      try {
        res = await fetch(this.url + item.route, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-moelog-key': this.key },
          body: item.body,
        })
      } catch (e) {
        // Server down or no network: retry, do not lose.
        this.retryLater(`no connection (${String(e)})`)
        return
      }

      if (res.ok) {
        this.queue.shift()
        this.sent++
        if (this.attempts > 0) {
          this.log(`upstream recovered (${this.queue.length} pending)`)
          this.attempts = 0
        }
        continue
      }

      if (res.status === 401 || res.status === 403) {
        // Terminal and global: retrying with the same key will not help.
        this.muted = true
        this.queue.length = 0
        this.log(`upstream muted: ${res.status}, check MOELOG_KEY`)
        return
      }

      if (res.status === 429 || res.status >= 500) {
        this.retryLater(`HTTP ${res.status}`)
        return
      }

      // A 4xx from the client side: the server will never accept this. Drop it.
      this.queue.shift()
      this.dropped++
      this.log(`upstream dropped a batch: HTTP ${res.status}`)
    }
  }

  private retryLater(reason: string): void {
    this.attempts++
    const wait = Math.min(1000 * 2 ** Math.min(this.attempts, 6), 60_000) + Math.random() * 250
    if (this.attempts === 1 || this.attempts % 5 === 0) {
      this.log(`upstream failing (${reason}); retry in ${Math.round(wait)} ms, ${this.queue.length} pending`)
    }
    this.schedule(wait)
  }

  /** One last attempt before the sidecar shuts down. */
  async close(capMs = 2000): Promise<void> {
    if (this.queue.length === 0 || !this.active) {
      this.closed = true
      return
    }
    const deadline = new Promise<void>((r) => setTimeout(r, capMs).unref())
    await Promise.race([this.pump(), deadline])
    this.closed = true
    if (this.queue.length > 0) {
      this.log(`upstream: ${this.queue.length} batches left unsent (they are in the NDJSON)`)
    }
  }
}
