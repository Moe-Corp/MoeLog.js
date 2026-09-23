import type { Frame } from './types.ts'

/**
 * V8-format stack parsing (Node, Bun, Chrome).
 *
 * Deliberately not called at capture time: `MoeEvent.raw` keeps the bare Error
 * and this runs on the deferred path, once the thread is free. That is the
 * difference between ~0.03 ms and ~0.4 ms per captured event.
 */
const LINE = /^\s*at\s+(?:(.+?)\s+\()?(?:async\s+)?(.+?):(\d+):(\d+)\)?\s*$/

export function parseStack(stack: string | undefined, limit = 20): Frame[] {
  if (!stack) return []
  const out: Frame[] = []
  const lines = stack.split('\n')
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const m = LINE.exec(lines[i]!)
    if (!m) continue
    out.push({
      fn: m[1] ?? '<anonymous>',
      file: m[2]!,
      line: +m[3]!,
      col: +m[4]!,
    })
  }
  return out
}

export interface NormalizedError {
  name: string
  msg: string
  frames: Frame[]
}

/** Normalizes anything throwable into something the server can index. */
export function normalizeError(input: unknown): NormalizedError {
  if (input instanceof Error) {
    return {
      name: input.name || 'Error',
      msg: input.message || String(input),
      frames: parseStack(input.stack),
    }
  }
  if (typeof input === 'object' && input !== null) {
    const o = input as { name?: unknown; message?: unknown; stack?: unknown }
    if (typeof o.message === 'string') {
      return {
        name: typeof o.name === 'string' ? o.name : 'Error',
        msg: o.message,
        frames: typeof o.stack === 'string' ? parseStack(o.stack) : [],
      }
    }
    let json: string
    try {
      json = JSON.stringify(input)
    } catch {
      json = '[unserializable object]'
    }
    return { name: 'NonError', msg: json.slice(0, 512), frames: [] }
  }
  return { name: 'NonError', msg: String(input).slice(0, 512), frames: [] }
}
