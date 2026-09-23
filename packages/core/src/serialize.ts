import type { AppContext, Envelope, MoeEvent, WireEvent, WireFrame } from './types.ts'

/**
 * MLWP v1: events as positional arrays.
 * [type, delta-t, level, message, ctx, fingerprint, frames?]
 *
 * The delta is relative to the batch base: small integers instead of a
 * 13-digit timestamp repeated on every event.
 */
export function toEnvelope(events: MoeEvent[], ctx: AppContext, sdk: string): Envelope {
  const base = events.length > 0 ? events[0]!.t : Date.now()
  const wire: WireEvent[] = new Array(events.length)

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!
    const row: WireEvent = [
      e.type,
      e.t - base,
      e.level,
      e.msg,
      e.ctx && Object.keys(e.ctx).length > 0 ? e.ctx : null,
      e.fp ?? null,
    ]
    if (e.frames && e.frames.length > 0) {
      row[6] = e.frames.map((f): WireFrame => [f.file, f.line, f.col, f.fn])
    }
    wire[i] = row
  }

  return { v: 1, sdk, t: base, ctx, e: wire }
}

/** The inverse: useful for the sidecar, the tests and the future server. */
export function fromEnvelope(env: Envelope): MoeEvent[] {
  return env.e.map((r) => ({
    type: r[0],
    t: env.t + r[1],
    level: r[2],
    msg: r[3],
    ctx: r[4] ?? undefined,
    fp: r[5] ?? undefined,
    frames: r[6]?.map((f) => ({ file: f[0], line: f[1], col: f[2], fn: f[3] })),
  }))
}
