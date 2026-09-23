import fs from 'node:fs'
import path from 'node:path'
import type { Envelope } from '@moecorp/moelog-core'
import type { AlertKind } from '../protocol.ts'
import type { Paths } from '../paths.ts'
import type { Upstream } from './upstream.ts'

/**
 * The sidecar's sinks.
 *
 * There are two: the NDJSON file, which is written ALWAYS, and — when
 * configured — the HTTP forward to the MoeLog server. The file is not a
 * degraded mode: it is the local record and the backup for whatever the server
 * does not receive.
 *
 * Whether the server is in the picture or not never touches the SDK or the
 * user's application. That indirection is the reason the sidecar exists.
 */
export class Sinks {
  private paths: Paths
  private streams = new Map<string, fs.WriteStream>()
  private webhook: string | undefined
  upstream: Upstream | null

  constructor(paths: Paths, upstream: Upstream | null = null) {
    this.paths = paths
    this.upstream = upstream
    this.webhook = process.env['MOELOG_WEBHOOK']
    fs.mkdirSync(paths.dataDir, { recursive: true })
  }

  private stream(file: string): fs.WriteStream {
    let s = this.streams.get(file)
    if (!s) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      s = fs.createWriteStream(file, { flags: 'a' })
      s.on('error', () => this.streams.delete(file))
      this.streams.set(file, s)
    }
    return s
  }

  events(env: Envelope, meta: { pid: number; app: string }): void {
    const line = JSON.stringify({ _recv: Date.now(), _pid: meta.pid, _app: meta.app, env })
    this.stream(this.paths.events()).write(line + '\n')
    this.upstream?.events(env, meta.pid)
  }

  alert(kind: AlertKind, detail: Record<string, unknown>): void {
    const rec = { t: Date.now(), kind, ...detail }
    const line = JSON.stringify(rec)
    this.stream(this.paths.alerts).write(line + '\n')
    this.log(`ALERT ${kind} ${line}`)
    this.notify(rec)
    this.upstream?.alert(rec)
  }

  log(msg: string): void {
    this.stream(this.paths.log).write(`${new Date().toISOString()} ${msg}\n`)
  }

  /** External notification channel. Fire-and-forget: a dead webhook cannot take the sidecar down. */
  private notify(rec: Record<string, unknown>): void {
    if (!this.webhook || typeof fetch !== 'function') return
    void fetch(this.webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rec),
    }).catch(() => undefined)
  }

  status(data: Record<string, unknown>): void {
    try {
      fs.writeFileSync(this.paths.status, JSON.stringify(data, null, 2))
    } catch {
      /* silence */
    }
  }

  close(): void {
    for (const s of this.streams.values()) {
      try {
        s.end()
      } catch {
        /* silence */
      }
    }
    this.streams.clear()
  }
}
