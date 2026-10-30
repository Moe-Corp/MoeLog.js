import { describe, expect, test } from 'bun:test'
import { fingerprintError, hash } from '../src/fingerprint.ts'
import { normalizeError, parseStack } from '../src/stack.ts'

describe('fingerprint', () => {
  test('hash is stable and 8 hex characters', () => {
    expect(hash('moelog')).toBe(hash('moelog'))
    expect(hash('moelog')).toMatch(/^[0-9a-f]{8}$/)
    expect(hash('a')).not.toBe(hash('b'))
  })

  test('ids, numbers and quoted literals land in the same issue', () => {
    const fp = (msg: string): string => fingerprintError('Error', msg)
    expect(fp('user 42 not found')).toBe(fp('user 77 not found'))
    expect(fp('order 3f2a9c1d8e7b missing')).toBe(fp('order a1b2c3d4e5f6 missing'))
    expect(fp('cannot read "name"')).toBe(fp('cannot read "email"'))
  })

  test('the error type and the top frame keep issues apart', () => {
    expect(fingerprintError('TypeError', 'boom')).not.toBe(fingerprintError('RangeError', 'boom'))
    expect(fingerprintError('Error', 'boom', 'a.ts:1')).not.toBe(fingerprintError('Error', 'boom', 'b.ts:1'))
  })
})

describe('parseStack', () => {
  test('reads named, anonymous and async V8 frames', () => {
    const stack = [
      'Error: boom',
      '    at handler (/app/src/routes.ts:12:7)',
      '    at /app/src/index.ts:3:1',
      '    at async main (/app/src/index.ts:9:3)',
    ].join('\n')
    expect(parseStack(stack)).toEqual([
      { fn: 'handler', file: '/app/src/routes.ts', line: 12, col: 7 },
      { fn: '<anonymous>', file: '/app/src/index.ts', line: 3, col: 1 },
      { fn: 'async main', file: '/app/src/index.ts', line: 9, col: 3 },
    ])
  })

  test('respects the frame limit and tolerates no stack', () => {
    const stack = Array.from({ length: 30 }, (_, i) => `    at f${i} (/a.ts:${i + 1}:1)`).join('\n')
    expect(parseStack(stack, 5)).toHaveLength(5)
    expect(parseStack(undefined)).toEqual([])
  })
})

describe('normalizeError', () => {
  test('an Error keeps its name, message and frames', () => {
    const n = normalizeError(new TypeError('bad input'))
    expect(n.name).toBe('TypeError')
    expect(n.msg).toBe('bad input')
    expect(n.frames.length).toBeGreaterThan(0)
  })

  test('an error-like object is treated as an error', () => {
    expect(normalizeError({ name: 'HttpError', message: '404' })).toEqual({ name: 'HttpError', msg: '404', frames: [] })
  })

  test('anything else becomes a NonError, capped at 512 characters', () => {
    expect(normalizeError({ code: 7 })).toEqual({ name: 'NonError', msg: '{"code":7}', frames: [] })
    expect(normalizeError('x'.repeat(600)).msg).toHaveLength(512)
  })

  test('a circular object does not throw', () => {
    const o: Record<string, unknown> = {}
    o['self'] = o
    expect(normalizeError(o).msg).toBe('[unserializable object]')
  })
})
