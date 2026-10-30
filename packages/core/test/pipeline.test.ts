import { describe, expect, test } from 'bun:test'
import { assertConfig } from '../src/assert.ts'
import { HookBus } from '../src/hooks.ts'
import { fromEnvelope, toEnvelope } from '../src/serialize.ts'
import { LEVEL, TYPE, type MoeEvent } from '../src/types.ts'

describe('MLWP serialization', () => {
  const events: MoeEvent[] = [
    { type: TYPE.log, t: 1_000, level: LEVEL.info, msg: 'started' },
    {
      type: TYPE.error, t: 1_250, level: LEVEL.error, msg: 'boom', ctx: { route: '/a' }, fp: 'abcd1234',
      frames: [{ file: '/a.ts', line: 1, col: 2, fn: 'f' }],
    },
  ]

  test('events travel as positional rows with a time delta', () => {
    const env = toEnvelope(events, { app: 'api' }, 'js-test/0')
    expect(env.v).toBe(1)
    expect(env.t).toBe(1_000)
    expect(env.e[0]).toEqual([TYPE.log, 0, LEVEL.info, 'started', null, null])
    expect(env.e[1]).toEqual([TYPE.error, 250, LEVEL.error, 'boom', { route: '/a' }, 'abcd1234', [['/a.ts', 1, 2, 'f']]])
  })

  test('fromEnvelope is the inverse of toEnvelope', () => {
    const back = fromEnvelope(toEnvelope(events, { app: 'api' }, 'js-test/0'))
    expect(back[1]).toEqual(events[1]!)
    expect(back[0]).toMatchObject({ type: TYPE.log, t: 1_000, msg: 'started' })
  })
})

describe('HookBus', () => {
  test('filters run in order and null drops the value', () => {
    const bus = new HookBus()
    bus.on('onCapture', (e) => ({ ...e, msg: e.msg + '-1' }))
    bus.on('onCapture', (e) => ({ ...e, msg: e.msg + '-2' }))
    const e: MoeEvent = { type: TYPE.log, t: 0, level: LEVEL.info, msg: 'x' }
    expect(bus.filter('onCapture', e)?.msg).toBe('x-1-2')

    bus.on('onCapture', () => null)
    expect(bus.filter('onCapture', e)).toBeNull()
  })

  test('a hook that throws is unregistered and never retried', () => {
    const bus = new HookBus()
    let calls = 0
    bus.on('beforeSend', () => {
      calls++
      throw new Error('broken integration')
    })
    const e: MoeEvent = { type: TYPE.log, t: 0, level: LEVEL.info, msg: 'x' }
    expect(bus.filter('beforeSend', e)).toBe(e)
    expect(bus.filter('beforeSend', e)).toBe(e)
    expect(calls).toBe(1)
  })

  test('the function returned by on() unsubscribes', () => {
    const bus = new HookBus()
    const off = bus.on('onCapture', () => null)
    off()
    const e: MoeEvent = { type: TYPE.log, t: 0, level: LEVEL.info, msg: 'x' }
    expect(bus.filter('onCapture', e)).toBe(e)
  })
})

describe('assertConfig', () => {
  test('accepts a valid configuration', () => {
    expect(() => assertConfig({ app: 'api', sampleRate: 0.5, maxBuffer: 64, flushAt: 32 })).not.toThrow()
  })

  test('rejects the mistakes that would surface as "nothing ever arrives"', () => {
    expect(() => assertConfig(null)).toThrow(TypeError)
    expect(() => assertConfig({ sampleRate: 2 })).toThrow('sampleRate')
    expect(() => assertConfig({ flushAt: 100, maxBuffer: 10 })).toThrow('flushAt')
    expect(() => assertConfig({ app: 42 })).toThrow('app must be a string')
    expect(() => assertConfig({ integrations: [{ name: 'x' }] })).toThrow('integration')
  })
})
