import { describe, expect, test } from 'bun:test'
import { createClient } from '../src/client.ts'
import { fromEnvelope } from '../src/serialize.ts'
import { LEVEL, TYPE, type Config, type Envelope, type TransportResult } from '../src/types.ts'

/**
 * A client wired to a fake transport and a manual scheduler: nothing runs until
 * the test says so, so there is no timing to flake on.
 */
function setup(config: Config = {}, results: TransportResult[] = []) {
  const sent: Envelope[] = []
  const timers: Array<{ fn: () => void; ms: number }> = []
  const client = createClient(config, {
    sdk: 'js-test/0',
    runtime: 'test',
    transport: {
      name: 'fake',
      async send(env) {
        sent.push(env)
        return results.shift() ?? { ok: true }
      },
    },
    schedule(fn, ms) {
      const t = { fn, ms }
      timers.push(t)
      return () => timers.splice(timers.indexOf(t), 1)
    },
  })
  const messages = (): string[] => sent.flatMap((env) => fromEnvelope(env).map((e) => e.msg))
  return { client, sent, timers, messages }
}

describe('createClient', () => {
  test('an error schedules an immediate flush; a log waits for the interval', () => {
    const a = setup({ flushIntervalMs: 5000 })
    a.client.capture(TYPE.log, LEVEL.info, 'hello')
    expect(a.timers.map((t) => t.ms)).toEqual([5000])

    a.client.capture(TYPE.error, LEVEL.error, new Error('boom'))
    expect(a.timers.map((t) => t.ms)).toEqual([0])
  })

  test('the stack is parsed on the flush, never stored raw in the envelope', async () => {
    const a = setup()
    a.client.capture(TYPE.error, LEVEL.error, new Error('boom'))
    await a.client.flush()
    const [e] = fromEnvelope(a.sent[0]!)
    expect(e!.msg).toBe('boom')
    expect(e!.frames!.length).toBeGreaterThan(0)
    expect(e!.ctx).toEqual({ name: 'Error' })
    expect(JSON.stringify(a.sent[0])).not.toContain('"raw"')
  })

  test('the same error inside the dedupe window is captured once', async () => {
    const a = setup({ dedupeWindowMs: 60_000 })
    a.client.capture(TYPE.error, LEVEL.error, new Error('user 1 not found'))
    a.client.capture(TYPE.error, LEVEL.error, new Error('user 2 not found'))
    await a.client.flush()
    expect(a.messages()).toEqual(['user 1 not found'])
    expect(a.client.stats().dropped).toBe(1)
  })

  test('sampleRate drops logs but errors follow errorSampleRate', async () => {
    const a = setup({ sampleRate: 0, errorSampleRate: 1 })
    a.client.capture(TYPE.log, LEVEL.info, 'noise')
    a.client.capture(TYPE.error, LEVEL.error, new Error('signal'))
    await a.client.flush()
    expect(a.messages()).toEqual(['signal'])
  })

  test('beforeSend can drop an event, and one that throws never breaks the app', async () => {
    const a = setup({
      beforeSend: (e) => {
        if (e.msg === 'secret') return null
        if (e.msg === 'explode') throw new Error('broken beforeSend')
        return e
      },
    })
    for (const m of ['secret', 'explode', 'kept']) a.client.capture(TYPE.log, LEVEL.info, m)
    await a.client.flush()
    expect(a.messages()).toEqual(['kept'])
  })

  test('a retryable failure puts the events back in the buffer; a final one does not', async () => {
    const a = setup({}, [{ ok: false, retry: true }, { ok: true }])
    a.client.capture(TYPE.log, LEVEL.info, 'again')
    await a.client.flush()
    expect(a.client.stats().buffered).toBe(1)
    await a.client.flush()
    expect(a.client.stats()).toMatchObject({ buffered: 0, sent: 1, failed: 1 })

    const b = setup({}, [{ ok: false, retry: false }])
    b.client.capture(TYPE.log, LEVEL.info, 'gone')
    await b.client.flush()
    expect(b.client.stats().buffered).toBe(0)
  })

  test('a transport that throws counts as retryable', async () => {
    const client = createClient({}, {
      sdk: 'js-test/0', runtime: 'test', schedule: () => () => undefined,
      transport: { name: 'throws', send: () => Promise.reject(new Error('socket gone')) },
    })
    client.capture(TYPE.log, LEVEL.info, 'kept')
    await client.flush()
    expect(client.stats().buffered).toBe(1)
  })

  test('close() flushes what is pending and then ignores new captures', async () => {
    const a = setup()
    a.client.capture(TYPE.log, LEVEL.info, 'last words')
    await a.client.close()
    a.client.capture(TYPE.log, LEVEL.info, 'too late')
    expect(a.messages()).toEqual(['last words'])
    expect(a.client.stats().buffered).toBe(0)
  })

  test('drainSync returns the pending envelope without sending it', () => {
    const a = setup()
    expect(a.client.drainSync()).toBeNull()
    a.client.capture(TYPE.error, LEVEL.fatal, new Error('dying'))
    const env = a.client.drainSync()
    expect(fromEnvelope(env!).map((e) => e.msg)).toEqual(['dying'])
    expect(a.sent).toHaveLength(0)
  })

  test('an integration that fails during setup does not break init', () => {
    expect(() =>
      setup({
        integrations: [{ name: 'broken', setup: () => { throw new Error('nope') } }],
      }),
    ).not.toThrow()
  })
})
