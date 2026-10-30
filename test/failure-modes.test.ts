/**
 * The test that matters: a dying process has to leave a trace.
 *
 * It starts a sidecar of its own in a temporary data directory, breaks an app
 * in every way the SDK promises to detect, under Node and under Bun, and checks
 * how the sidecar classified each death. Every app runs at the same time, so
 * the whole suite costs about as much as its slowest scenario.
 *
 * It runs against the built packages (`bun run build` first): that is what a
 * user installs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
const APP = path.join(ROOT, 'test/fixtures/app.mjs')
const NOSTART = path.join(ROOT, 'test/fixtures/nostart.mjs')
const CLI = path.join(ROOT, 'packages/sidecar/dist/cli.js')
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'moelog-test-'))

const RUNTIMES = ['node', 'bun'] as const
type Runtime = (typeof RUNTIMES)[number]
const BIN: Record<Runtime, string> = { node: Bun.which('node') ?? 'node', bun: process.execPath }

// The developer's own sidecar must never see these apps, nor these apps it.
const env: Record<string, string | undefined> = { ...process.env, MOELOG_DATA: DATA }
delete env['MOELOG_SOCK']
delete env['MOELOG_SERVER']
delete env['MOELOG_WEBHOOK']

const TIMEOUT = 15_000
const children: ChildProcess[] = []
const exits = new Map<string, Promise<void>>()

interface Alert {
  kind: string
  app?: string
  code?: number
  cmd?: string
  error?: { message?: string }
}

function start(cmd: string, args: string[]): ChildProcess {
  const child = spawn(cmd, args, { env, stdio: 'ignore' })
  children.push(child)
  return child
}

const exited = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })

function ndjson<T>(file: string): T[] {
  let raw = ''
  try {
    raw = fs.readFileSync(path.join(DATA, file), 'utf8')
  } catch {
    return []
  }
  const out: T[] = []
  for (const line of raw.split('\n')) {
    try {
      if (line) out.push(JSON.parse(line) as T)
    } catch {
      /* a line still being written */
    }
  }
  return out
}

const alerts = (): Alert[] => ndjson<Alert>('alerts.ndjson')

function daemonLog(): string {
  try {
    return fs.readFileSync(path.join(DATA, 'daemon.log'), 'utf8')
  } catch {
    return ''
  }
}

/** Every event message the sidecar recorded for an app, from any day's file. */
function eventsOf(app: string): Array<{ level: number; msg: string }> {
  const files = fs.existsSync(DATA) ? fs.readdirSync(DATA).filter((f) => f.startsWith('events-')) : []
  return files.flatMap((f) =>
    ndjson<{ _app: string; env: { e: Array<[number, number, number, string]> } }>(f)
      .filter((r) => r._app === app)
      .flatMap((r) => r.env.e.map((e) => ({ level: e[2], msg: e[3] }))),
  )
}

async function until<T>(probe: () => T | undefined | null | false, what: string): Promise<T> {
  const end = Date.now() + TIMEOUT - 1000
  for (;;) {
    const v = probe()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(50)
  }
}

const alertFor = (kind: string, app: string): Promise<Alert> =>
  until(() => alerts().find((a) => a.kind === kind && a.app === app), `${kind} for ${app}`)

const noAlertFor = (app: string): Alert[] => alerts().filter((a) => a.app === app)

/** Launches an app that stays up, waits until the sidecar has seen it, then kills it. */
async function killOnceConnected(rt: Runtime, app: string, signal: NodeJS.Signals): Promise<void> {
  const child = start(BIN[rt], [APP, 'alive', app])
  await until(() => daemonLog().includes(`+ app ${app} pid=${child.pid}`), `${app} to connect`)
  child.kill(signal)
  await exited(child)
}

beforeAll(async () => {
  if (!fs.existsSync(CLI)) throw new Error('packages are not built: run `bun run build` first')

  await exited(start(BIN.node, [CLI, 'spawn']))
  await until(() => fs.existsSync(path.join(DATA, 'daemon.json')), 'the sidecar to listen')

  for (const rt of RUNTIMES) {
    for (const scenario of ['crash', 'reject', 'block', 'exit1', 'clean']) {
      exits.set(`${rt}-${scenario}`, exited(start(BIN[rt], [APP, scenario, `${rt}-${scenario}`])))
    }
    exits.set(`${rt}-sigkill`, killOnceConnected(rt, `${rt}-sigkill`, 'SIGKILL'))
    exits.set(`${rt}-sigterm`, killOnceConnected(rt, `${rt}-sigterm`, 'SIGTERM'))
    // The trailing argument only tags the command line, so each runtime's alert can be told apart.
    exits.set(`${rt}-nostart`, exited(start(BIN.node, [CLI, 'run', '--', BIN[rt], NOSTART, rt])))
  }
})

afterAll(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  await exited(start(BIN.node, [CLI, 'stop']))
  fs.rmSync(DATA, { recursive: true, force: true })
})

for (const rt of RUNTIMES) {
  describe(`${rt}`, () => {
    test('an uncaught exception is reported as app.fatal, with the error', async () => {
      const a = await alertFor('app.fatal', `${rt}-crash`)
      expect(a.error?.message).toBe(`uncaught exception from ${rt}-crash`)
    }, TIMEOUT)

    if (rt === 'node') {
      test('an unhandled rejection kills the process and is reported as app.fatal', async () => {
        const a = await alertFor('app.fatal', 'node-reject')
        expect(a.error?.message).toBe('rejected promise from node-reject')
      }, TIMEOUT)
    } else {
      test('an unhandled rejection is recorded as an error event; the app lives on, so no alert', async () => {
        const e = await until(
          () => eventsOf('bun-reject').find((ev) => ev.msg === 'rejected promise from bun-reject'),
          'the rejection event',
        )
        expect(e.level).toBe(50)
        await exits.get('bun-reject')
        await until(() => /app bun-reject \(pid \d+\) exited cleanly/.test(daemonLog()), 'the clean exit')
        expect(noAlertFor('bun-reject')).toEqual([])
      }, TIMEOUT)
    }

    test('a blocked event loop is reported as app.blocked, then app.recovered', async () => {
      await alertFor('app.blocked', `${rt}-block`)
      await alertFor('app.recovered', `${rt}-block`)
    }, TIMEOUT)

    test('exiting with code 1 is reported as app.exited_error', async () => {
      const a = await alertFor('app.exited_error', `${rt}-exit1`)
      expect(a.code).toBe(1)
    }, TIMEOUT)

    test('SIGKILL, with no chance to say goodbye, is reported as app.crashed', async () => {
      await alertFor('app.crashed', `${rt}-sigkill`)
    }, TIMEOUT)

    test('SIGTERM is a deliberate stop: logged, not alerted', async () => {
      await exits.get(`${rt}-sigterm`)
      await until(() => new RegExp(`app ${rt}-sigterm \\(pid \\d+\\) terminated by SIGTERM`).test(daemonLog()), 'the SIGTERM log line')
      expect(noAlertFor(`${rt}-sigterm`)).toEqual([])
    }, TIMEOUT)

    test('a clean exit raises no alert', async () => {
      await exits.get(`${rt}-clean`)
      await until(() => new RegExp(`app ${rt}-clean \\(pid \\d+\\) exited cleanly`).test(daemonLog()), 'the clean exit')
      expect(noAlertFor(`${rt}-clean`)).toEqual([])
    }, TIMEOUT)

    test('an app that dies before initializing the SDK is reported, when supervised, as app.failed_to_start', async () => {
      await until(
        () => alerts().find((a) => a.kind === 'app.failed_to_start' && a.cmd?.endsWith(`nostart.mjs ${rt}`)),
        `app.failed_to_start for ${rt}`,
      )
    }, TIMEOUT)
  })
}
