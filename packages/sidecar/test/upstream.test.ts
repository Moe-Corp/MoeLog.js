import { afterEach, describe, expect, test } from 'bun:test'
import type { Envelope } from '@moecorp/moelog-core'
import { Upstream } from '../src/daemon/upstream.ts'

const env: Envelope = { v: 1, sdk: 'js-test/0', t: 1, ctx: { app: 'api' }, e: [] }

/** A real HTTP server that answers with whatever status the test queues up. */
function server(statuses: number[]) {
  const received: Array<{ route: string; key: string | null; body: unknown }> = []
  const s = Bun.serve({
    port: 0,
    async fetch(req) {
      received.push({ route: new URL(req.url).pathname, key: req.headers.get('x-moelog-key'), body: await req.json() })
      return new Response(null, { status: statuses.shift() ?? 200 })
    },
  })
  return { url: `http://localhost:${s.port}`, received, stop: () => s.stop(true) }
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await Bun.sleep(20)
  }
}

describe('Upstream', () => {
  let stop: (() => void) | null = null
  afterEach(() => stop?.())

  test('sends events with the key and adds the pid the SDK does not know', async () => {
    const srv = server([200])
    stop = srv.stop
    const up = new Upstream({ url: srv.url + '/', key: 'mlk_test', log: () => undefined })
    up.events(env, 4242)
    await until(() => up.sent === 1)
    expect(srv.received[0]).toMatchObject({ route: '/v1/ingest', key: 'mlk_test', body: { ctx: { app: 'api', pid: 4242 } } })
    expect(up.pending).toBe(0)
  })

  test('a 5xx is retried, not lost', async () => {
    const srv = server([503, 200])
    stop = srv.stop
    const up = new Upstream({ url: srv.url, key: 'k', log: () => undefined })
    up.alert({ kind: 'app.crashed' })
    await until(() => up.sent === 1)
    expect(srv.received.map((r) => r.route)).toEqual(['/v1/alerts', '/v1/alerts'])
  })

  test('a 401 mutes the upstream: retrying with the same key will not help', async () => {
    const srv = server([401])
    stop = srv.stop
    const logs: string[] = []
    const up = new Upstream({ url: srv.url, key: 'wrong', log: (m) => logs.push(m) })
    up.events(env, 1)
    await until(() => !up.active)
    up.events(env, 1)
    expect(up.pending).toBe(0)
    expect(logs.join('\n')).toContain('MOELOG_KEY')
  })

  test('another 4xx drops that batch and keeps going', async () => {
    const srv = server([400, 200])
    stop = srv.stop
    const up = new Upstream({ url: srv.url, key: 'k', log: () => undefined })
    up.events(env, 1)
    up.events(env, 2)
    await until(() => up.sent === 1)
    expect(up.dropped).toBe(1)
  })

  test('with the server down the queue holds, capped at its limit', async () => {
    const up = new Upstream({ url: 'http://127.0.0.1:9', key: 'k', log: () => undefined, limit: 2 })
    for (let pid = 1; pid <= 3; pid++) up.events(env, pid)
    expect(up.pending).toBe(2)
    expect(up.dropped).toBe(1)
    await up.close(100)
  })
})
