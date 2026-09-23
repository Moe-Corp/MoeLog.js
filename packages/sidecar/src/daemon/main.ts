import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fromEnvelope, parseStack, type Envelope, type WireFrame } from '@moecorp/moelog-core'
import { LineDecoder, safeParse, type ClientMsg, type Hello } from '../protocol.ts'
import { resolvePaths } from '../paths.ts'
import { takeCrashMarker, takeExitMarker, takePendingMarker, type CrashMarker } from '../markers.ts'
import { Sinks } from './sinks.ts'
import { Upstream } from './upstream.ts'

/**
 * The sidecar. A separate, detached Node process that outlives the app.
 *
 * It does three things:
 *  1. receives MLWP batches and persists them (a file today, the server later),
 *  2. watches the heartbeat of every connected app,
 *  3. classifies *how* each app died, and reports it.
 */

interface ClientState {
  id: number
  hello: Hello | null
  lastHb: number
  blocked: boolean
  saidBye: { code: number | null; signal: string | null } | null
  events: number
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback
}

const paths = resolvePaths(arg('data', process.env['MOELOG_DATA'] ?? ''))
const sockPath = arg('sock', paths.sock)
/** Consecutive missed beats before an app is declared blocked. */
const MISSED_BEATS = 3
/** The sidecar shuts itself down after this long with no clients. 0 = never. */
const idleMs = Number(arg('idle-ms', '120000'))
/** Grace period for on-disk markers to appear after a disconnect. */
const POST_MORTEM_MS = 400
/** Age at which an unclaimed marker is considered orphaned. */
const ORPHAN_MS = 3000

/**
 * Forwarding to the MoeLog server. Optional: without `--server`/`MOELOG_SERVER`
 * the sidecar works the same and keeps the local NDJSON.
 */
const serverUrl = arg('server', process.env['MOELOG_SERVER'] ?? '')
const upstream = serverUrl
  ? new Upstream({
      url: serverUrl,
      key: arg('key', process.env['MOELOG_KEY'] ?? 'mlk_pub_dev'),
      log: (m) => sinks.log(m),
    })
  : null

const sinks = new Sinks(paths, upstream)
const clients = new Map<net.Socket, ClientState>()
let nextId = 1
let idleTimer: NodeJS.Timeout | null = null

/**
 * A crash has to show up in two places: as an alert (to warn) and as an event
 * (so it sits in the history alongside everything else). The process died
 * before it could send it, so the sidecar synthesizes it from the marker.
 */
function recordCrashAsEvent(c: CrashMarker): void {
  const frames: WireFrame[] = parseStack(c.stack ?? undefined).map((f) => [f.file, f.line, f.col, f.fn])
  const env: Envelope = {
    v: 1,
    sdk: 'sidecar',
    t: c.t,
    ctx: { app: c.app, rt: 'unknown' },
    e: [[1, 0, 60, `${c.name}: ${c.message}`, { origin: c.origin, fatal: true }, null, frames]],
  }
  sinks.events(env, { pid: c.pid, app: c.app })
}

/**
 * Sweep for orphaned markers.
 *
 * This covers the two gaps that disconnect-based classification cannot see: an
 * app that died before finishing the handshake, and an app that died while the
 * sidecar was not running. In both cases the marker was left on disk with
 * nobody to read it; this picks it up.
 */
function sweepOrphanMarkers(): void {
  let files: string[]
  try {
    files = fs.readdirSync(paths.dataDir)
  } catch {
    return
  }

  const live = new Set<number>()
  for (const st of clients.values()) if (st.hello) live.add(st.hello.pid)

  const now = Date.now()
  const seen = new Set<number>()
  for (const f of files) {
    const m = /^(?:crash|exit|pending)-(\d+)\.json$/.exec(f)
    if (!m) continue
    const pid = Number(m[1])
    if (live.has(pid) || seen.has(pid)) continue
    try {
      if (now - fs.statSync(path.join(paths.dataDir, f)).mtimeMs < ORPHAN_MS) continue
    } catch {
      continue
    }
    seen.add(pid)

    const crash = takeCrashMarker(paths, pid)
    const exit = takeExitMarker(paths, pid)
    const pending = takePendingMarker(paths, pid)
    const app = crash?.app ?? exit?.app ?? (pending?.ctx.app as string | undefined) ?? 'unknown'
    if (pending) sinks.events(pending, { pid, app })

    if (crash) {
      if (!pending) recordCrashAsEvent(crash)
      sinks.alert('app.fatal', {
        app, pid, orphan: true,
        error: { name: crash.name, message: crash.message, stack: crash.stack, origin: crash.origin },
      })
    } else if (exit && exit.code !== null && exit.code !== 0) {
      sinks.alert('app.exited_error', { app, pid, code: exit.code, orphan: true })
    } else if (exit) {
      sinks.log(`orphan marker: ${app} (pid ${pid}) had exited cleanly`)
    }
  }
}

function classifyDisconnect(st: ClientState): void {
  const hello = st.hello
  // Only apps get classified. The supervisor (`moelog run`) disconnects when it
  // finishes and writes no markers: treating it as an app would report a crash
  // on every single run.
  if (!hello || hello.role !== 'app') return
  const pid = hello.pid
  const base = { app: hello.app, pid, rt: hello.rt, cwd: hello.cwd }

  const crash = takeCrashMarker(paths, pid)
  const exit = takeExitMarker(paths, pid)
  // The last thing the app managed to dump before dying.
  const pending = takePendingMarker(paths, pid)
  if (pending) sinks.events(pending, { pid, app: hello.app })

  if (crash) {
    // Uncaught exception. If the last-gasp dump arrived the event is already
    // recorded and synthesizing it again would duplicate it; if it did not,
    // the marker is all that is left.
    if (!pending) recordCrashAsEvent(crash)
    sinks.alert('app.fatal', {
      ...base,
      error: { name: crash.name, message: crash.message, stack: crash.stack, origin: crash.origin },
    })
    return
  }

  if (st.saidBye?.signal || exit?.signal) {
    sinks.log(`app ${hello.app} (pid ${pid}) terminated by ${st.saidBye?.signal ?? exit?.signal}`)
    return // Ctrl+C / SIGTERM is a deliberate exit, not an alert
  }

  const code = st.saidBye?.code ?? exit?.code ?? null
  if (code !== null && code !== 0) {
    sinks.alert('app.exited_error', { ...base, code })
    return
  }
  if (exit || st.saidBye) {
    sinks.log(`app ${hello.app} (pid ${pid}) exited cleanly`)
    return
  }

  // No exit marker and no goodbye: it died instantly. SIGKILL, kernel OOM,
  // a runtime segfault, a container getting trimmed.
  sinks.alert('app.crashed', { ...base, hint: 'no exit marker: abrupt death (SIGKILL/OOM/panic)' })
}

function onLine(sock: net.Socket, st: ClientState, line: string): void {
  const msg = safeParse<ClientMsg>(line)
  if (!msg) return

  switch (msg.k) {
    case 'hello': {
      st.hello = msg
      st.lastHb = Date.now()
      sinks.log(`+ ${msg.role} ${msg.app} pid=${msg.pid} ${msg.rt} sdk=${msg.sdk}`)
      break
    }
    case 'hb': {
      st.lastHb = Date.now()
      if (st.blocked) {
        st.blocked = false
        sinks.alert('app.recovered', { app: st.hello?.app, pid: st.hello?.pid, lagMs: msg.lagMs })
      }
      break
    }
    case 'batch': {
      const n = msg.env.e.length
      st.events += n
      sinks.events(msg.env, { pid: st.hello?.pid ?? 0, app: st.hello?.app ?? 'unknown' })
      // Errors also get announced in the sidecar log: with no dashboard yet,
      // this is the only thing there is to watch live.
      for (const e of fromEnvelope(msg.env)) {
        if (e.level >= 50) sinks.log(`! ${e.msg} ${e.frames?.[0] ? `(${e.frames[0].file}:${e.frames[0].line})` : ''}`)
      }
      break
    }
    case 'bye': {
      st.saidBye = { code: msg.code, signal: msg.signal }
      break
    }
    case 'alert': {
      // Comes from the supervisor (`moelog run`): the only one that can see a
      // failed startup.
      sinks.alert(msg.kind, msg.detail)
      break
    }
  }
  void sock
}

const server = net.createServer((sock) => {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  sock.setNoDelay(true)
  sock.setEncoding('utf8')

  const st: ClientState = {
    id: nextId++,
    hello: null,
    lastHb: Date.now(),
    blocked: false,
    saidBye: null,
    events: 0,
  }
  clients.set(sock, st)

  const dec = new LineDecoder()
  sock.on('data', (chunk: string) => dec.push(chunk, (l) => onLine(sock, st, l)))
  sock.on('error', () => sock.destroy())
  sock.on('close', () => {
    clients.delete(sock)
    const hello = st.hello
    if (hello) sinks.log(`- ${hello.app} pid=${hello.pid} events=${st.events}`)
    setTimeout(() => classifyDisconnect(st), POST_MORTEM_MS).unref()
    scheduleIdleShutdown()
  })
})

function scheduleIdleShutdown(): void {
  if (idleMs <= 0 || clients.size > 0 || idleTimer) return
  idleTimer = setTimeout(() => {
    if (clients.size === 0) {
      sinks.log('no clients: the sidecar is shutting down')
      void shutdown(0)
    }
  }, idleMs)
  idleTimer.unref()
}

/**
 * Heartbeat watchdog. If a live app stops beating, its event loop is blocked:
 * it did not die, it stopped serving. This is the failure no in-process SDK can
 * report, because reporting it would need the very event loop that is blocked.
 */
const watchdog = setInterval(() => {
  // If the data directory vanished, this sidecar is writing into deleted
  // inodes: it looks like it works but nobody will ever see an event from it
  // again. Stepping aside is the only honest thing, and it frees the socket
  // for whichever sidecar comes next.
  if (!fs.existsSync(paths.dataDir)) {
    void shutdown(0)
    return
  }
  // The status file is how `moelog stop` finds this process. If somebody
  // deleted it, write it again: without it this process cannot be stopped.
  if (!fs.existsSync(paths.status)) writeStatus()
  // Refresh it every 10 s so `moelog status` shows the real upstream queue.
  else if (upstream && Date.now() - lastStatus > 10_000) {
    lastStatus = Date.now()
    writeStatus()
  }

  const now = Date.now()
  for (const st of clients.values()) {
    const hello = st.hello
    if (!hello || hello.role !== 'app' || st.blocked) continue
    const budget = hello.hbMs * MISSED_BEATS
    if (now - st.lastHb > budget) {
      st.blocked = true
      sinks.alert('app.blocked', {
        app: hello.app,
        pid: hello.pid,
        silentMs: now - st.lastHb,
        hint: `no heartbeat for more than ${budget} ms: event loop blocked`,
      })
    }
  }
}, 1000)
watchdog.unref()

const sweeper = setInterval(sweepOrphanMarkers, 5000)

let shuttingDown = false

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(watchdog)
  clearInterval(sweeper)
  try {
    server.close()
  } catch {
    /* silence */
  }
  // One last attempt to drain the queue before leaving: whatever does not go
  // out stays in the NDJSON, but losing it from the server over two seconds of
  // haste would be silly.
  await upstream?.close(2000)
  try {
    fs.unlinkSync(paths.status)
  } catch {
    /* silence */
  }
  sinks.close()
  process.exit(code)
}

const startedAt = Date.now()
let lastStatus = 0
const writeStatus = (): void =>
  sinks.status({
    pid: process.pid,
    sock: sockPath,
    dataDir: paths.dataDir,
    started: startedAt,
    server: serverUrl || null,
    upstream: upstream
      ? { active: upstream.active, sent: upstream.sent, pending: upstream.pending, dropped: upstream.dropped }
      : null,
  })

function listen(): void {
  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') {
      sinks.log(`could not listen: ${err.message}`)
      process.exit(1)
    }
    // Could be an orphaned socket from a dead daemon, or a live one.
    const probe = net.createConnection({ path: sockPath })
    probe.on('connect', () => {
      probe.destroy()
      // A sidecar is already running: this one is redundant. Release the lock
      // before leaving, or the next legitimate start waits 10 s for nothing.
      try {
        fs.unlinkSync(paths.lock)
      } catch {
        /* silence */
      }
      process.exit(0)
    })
    probe.on('error', () => {
      try {
        fs.unlinkSync(sockPath)
      } catch {
        /* silence */
      }
      server.listen(sockPath, ready)
    })
  })
  server.listen(sockPath, ready)
}

function ready(): void {
  try {
    fs.unlinkSync(paths.lock)
  } catch {
    /* silence */
  }
  writeStatus()
  sinks.log(`sidecar listening on ${sockPath} (pid ${process.pid})`)
  sinks.log(serverUrl ? `forwarding to ${serverUrl}` : 'no server: local NDJSON only')
  // On start there may be corpses from before: apps that died with no sidecar.
  setTimeout(sweepOrphanMarkers, 100).unref()
  sweeper.unref()
  scheduleIdleShutdown()
  if (process.send) process.send({ k: 'ready' })
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void shutdown(0))
process.on('uncaughtException', (e) => {
  sinks.log(`the sidecar itself failed: ${e.stack ?? e.message}`)
})

listen()
