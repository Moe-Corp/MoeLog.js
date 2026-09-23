import type { Envelope } from '@moecorp/moelog-core'

/**
 * App <-> sidecar protocol. NDJSON over a unix socket (a named pipe on Windows).
 *
 * Deliberately different from MLWP: MLWP is what the *sidecar* sends to the
 * server. This is only the local handoff, and it also carries the health
 * signals the server has no reason to see.
 */

export type AlertKind =
  | 'app.crashed'
  | 'app.blocked'
  | 'app.recovered'
  | 'app.exited_error'
  | 'app.failed_to_start'
  | 'app.fatal'

export interface Hello {
  k: 'hello'
  pid: number
  rt: string
  app: string
  sdk: string
  role: 'app' | 'supervisor'
  cwd: string
  hbMs: number
}

export type ClientMsg =
  | Hello
  | { k: 'batch'; env: Envelope }
  | { k: 'hb'; t: number; lagMs: number; rssMb: number }
  | { k: 'bye'; code: number | null; signal: string | null }
  | { k: 'alert'; kind: AlertKind; detail: Record<string, unknown> }

export type DaemonMsg = { k: 'ack'; n: number } | { k: 'nack'; reason: string }

export const encode = (m: ClientMsg | DaemonMsg): string => JSON.stringify(m) + '\n'

/**
 * Incremental line decoder. A socket does not respect message boundaries, so
 * the chunks have to be reassembled.
 */
export class LineDecoder {
  private buf = ''
  private limit: number

  constructor(limitBytes = 4 * 1024 * 1024) {
    this.limit = limitBytes
  }

  push(chunk: string, onLine: (line: string) => void): void {
    this.buf += chunk
    if (this.buf.length > this.limit) {
      this.buf = '' // absurd line: cut it loose rather than grow without bound
      return
    }
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      if (line.length > 0) onLine(line)
    }
  }
}

/** Never trust the line to be valid JSON: it comes from another process. */
export function safeParse<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T
  } catch {
    return null
  }
}
