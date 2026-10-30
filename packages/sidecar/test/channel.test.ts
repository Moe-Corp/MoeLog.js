import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  takeCrashMarker,
  takeExitMarker,
  takePendingMarker,
  writeCrashMarker,
  writeExitMarker,
  writePendingMarker,
} from '../src/markers.ts'
import { resolvePaths } from '../src/paths.ts'
import { encode, LineDecoder, safeParse, type ClientMsg } from '../src/protocol.ts'

describe('LineDecoder', () => {
  test('reassembles messages split across chunks', () => {
    const lines: string[] = []
    const dec = new LineDecoder()
    for (const chunk of ['{"k":"h', 'b"}\n{"k":', '"bye"}\n\n']) dec.push(chunk, (l) => lines.push(l))
    expect(lines).toEqual(['{"k":"hb"}', '{"k":"bye"}'])
  })

  test('an absurd line is cut loose instead of growing without bound', () => {
    const lines: string[] = []
    const dec = new LineDecoder(16)
    dec.push('x'.repeat(32), (l) => lines.push(l))
    dec.push('ok\n', (l) => lines.push(l))
    expect(lines).toEqual(['ok'])
  })

  test('encode writes one line and safeParse never throws', () => {
    const line = encode({ k: 'hb', t: 1, lagMs: 0, rssMb: 10 })
    expect(line.endsWith('\n')).toBe(true)
    expect(safeParse<ClientMsg>(line.trim())).toEqual({ k: 'hb', t: 1, lagMs: 0, rssMb: 10 })
    expect(safeParse<ClientMsg>('{not json')).toBeNull()
  })
})

describe('resolvePaths', () => {
  const saved = { data: process.env['MOELOG_DATA'], sock: process.env['MOELOG_SOCK'] }
  afterEach(() => {
    for (const [k, v] of [['MOELOG_DATA', saved.data], ['MOELOG_SOCK', saved.sock]] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  test('the socket is derived from the data directory, outside the project', () => {
    delete process.env['MOELOG_SOCK']
    const a = resolvePaths('/srv/app-a/.moelog')
    expect(a.sock).toBe(resolvePaths('/srv/app-a/.moelog').sock)
    expect(a.sock).not.toBe(resolvePaths('/srv/app-b/.moelog').sock)
    if (process.platform !== 'win32') expect(a.sock.startsWith(os.tmpdir())).toBe(true)
  })

  test('MOELOG_DATA and MOELOG_SOCK are honoured', () => {
    process.env['MOELOG_DATA'] = '/tmp/from-env'
    process.env['MOELOG_SOCK'] = '/tmp/custom.sock'
    const p = resolvePaths()
    expect(p.dataDir).toBe(path.resolve('/tmp/from-env'))
    expect(p.sock).toBe('/tmp/custom.sock')
  })

  test('events are split into one file per day', () => {
    const p = resolvePaths('/srv/app/.moelog')
    expect(p.events(new Date(2026, 0, 5))).toBe(path.join('/srv/app/.moelog', 'events-2026-01-05.ndjson'))
  })
})

describe('markers', () => {
  test('each marker is read once and then removed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moelog-markers-'))
    try {
      const p = resolvePaths(dir)
      writeExitMarker(p, { pid: 7, app: 'api', code: 1, signal: null, t: 1 })
      writeCrashMarker(p, { pid: 7, app: 'api', name: 'Error', message: 'boom', stack: null, origin: 'uncaughtException', t: 1 })
      writePendingMarker(p, 7, { v: 1, sdk: 'js-test/0', t: 1, ctx: { app: 'api' }, e: [] })

      expect(takeExitMarker(p, 7)?.code).toBe(1)
      expect(takeCrashMarker(p, 7)?.message).toBe('boom')
      expect(takePendingMarker(p, 7)?.ctx.app).toBe('api')
      expect(fs.readdirSync(dir)).toEqual([])
      expect(takeExitMarker(p, 7)).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
