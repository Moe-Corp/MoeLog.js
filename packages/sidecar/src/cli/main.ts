import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import { fromEnvelope, type Envelope } from '@moecorp/moelog-core'
import { ensureDaemon, probeDaemon, spawnDaemon } from '../daemon/launch.ts'
import { resolvePaths } from '../paths.ts'
import { encode } from '../protocol.ts'
import { VERSION } from '../version.ts'

const HELP = `moelog ${VERSION}

  moelog run -- <command>   Run your app under the sidecar's supervision.
                            It is the only way to detect "it never started".
  moelog daemon             Run the sidecar in the foreground (for debugging).
  moelog status             Sidecar status and upstream queue.
  moelog tail [-n 20]       Latest events received.
  moelog alerts [-n 20]     Latest alerts (crashes, blocks, failed starts).
  moelog stop               Shut the sidecar down.

Global options:
  --data <dir>              Data directory (defaults to ./.moelog)

Server forwarding:
  --server <url>            MoeLog server URL (or MOELOG_SERVER)
  --key <key>               Ingest key (or MOELOG_KEY)

Environment variables:
  MOELOG_DATA               Same as --data
  MOELOG_SOCK               Socket path
  MOELOG_WEBHOOK            URL the sidecar POSTs every alert to
  MOELOG_NODE               Node binary used to launch the sidecar
`

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const num = (name: string, d: number): number => {
  const i = argv.findIndex((a) => a === `-${name}` || a === `--${name}`)
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d
}

const paths = resolvePaths(flag('data'))
const cmd = argv[0] ?? 'help'

function tailLines(file: string, n: number): string[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n)
  } catch {
    return []
  }
}

const LEVEL_NAME: Record<number, string> = {
  10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'ERROR', 60: 'FATAL',
}

async function main(): Promise<void> {
  switch (cmd) {
    // -------------------------------------------------------------- supervisor
    case 'run': {
      const sep = argv.indexOf('--')
      const child = sep >= 0 ? argv.slice(sep + 1) : []
      if (child.length === 0) {
        console.error('usage: moelog run -- <command>')
        process.exit(2)
      }
      await ensureDaemon(paths, 3000, {
        ...(flag('server') ? { server: flag('server')! } : {}),
        ...(flag('key') ? { key: flag('key')! } : {}),
      })

      // The supervisor connects as just another client: it is the only one that
      // can see the app die BEFORE it ever got to initialize the SDK.
      const sock = net.createConnection({ path: paths.sock })
      sock.on('error', () => undefined)
      const say = (line: string): void => {
        if (!sock.destroyed && sock.writable) sock.write(line)
      }
      sock.on('connect', () =>
        say(
          encode({
            k: 'hello', pid: process.pid, rt: `node/${process.versions.node}`,
            app: process.env['MOELOG_APP'] ?? 'supervisor', sdk: `cli/${VERSION}`,
            role: 'supervisor', cwd: process.cwd(), hbMs: 0,
          }),
        ),
      )

      const readyMs = num('ready-ms', 3000)
      const started = Date.now()
      const proc = spawn(child[0]!, child.slice(1), {
        stdio: 'inherit',
        env: { ...process.env, MOELOG_DATA: paths.dataDir, MOELOG_SOCK: paths.sock, MOELOG_SUPERVISED: '1' },
      })

      for (const sig of ['SIGINT', 'SIGTERM'] as const) {
        process.on(sig, () => proc.kill(sig))
      }

      proc.on('error', (err) => {
        say(encode({ k: 'alert', kind: 'app.failed_to_start',
          detail: { cmd: child.join(' '), reason: String(err), elapsedMs: Date.now() - started } }))
        setTimeout(() => process.exit(127), 150)
      })

      proc.on('exit', (code, signal) => {
        const elapsed = Date.now() - started
        // A non-zero exit inside the startup window means it never came alive.
        if ((code ?? 0) !== 0 && elapsed < readyMs) {
          say(encode({ k: 'alert', kind: 'app.failed_to_start',
            detail: { cmd: child.join(' '), code, signal, elapsedMs: elapsed } }))
        }
        setTimeout(() => process.exit(code ?? (signal ? 1 : 0)), 150)
      })
      break
    }

    // ------------------------------------------------------------------ daemon
    case 'daemon': {
      const { daemonEntry, defaultRuntime } = await import('../daemon/launch.ts')
      const entry = daemonEntry()
      const p = spawn(defaultRuntime(entry), [entry, '--sock', paths.sock, '--data', paths.dataDir, '--idle-ms', '0'], {
        stdio: 'inherit',
      })
      p.on('exit', (c) => process.exit(c ?? 0))
      break
    }

    // ------------------------------------------------------------------ status
    case 'status': {
      const alive = await probeDaemon(paths.sock)
      let st: Record<string, unknown> = {}
      try {
        st = JSON.parse(fs.readFileSync(paths.status, 'utf8')) as Record<string, unknown>
      } catch {
        /* no status file */
      }
      console.log(`sidecar:  ${alive ? 'running' : 'stopped'}`)
      console.log(`socket:   ${paths.sock}`)
      console.log(`data:     ${paths.dataDir}`)
      if (st['pid']) console.log(`pid:      ${String(st['pid'])}`)
      if (st['started']) console.log(`since:    ${new Date(Number(st['started'])).toLocaleString()}`)
      if (st['server']) console.log(`server:   ${String(st['server'])}`)
      if (st['upstream']) console.log(`upstream: ${JSON.stringify(st['upstream'])}`)
      const ev = tailLines(paths.events(), 1)
      const al = tailLines(paths.alerts, 1)
      console.log(`events:   ${fs.existsSync(paths.events()) ? paths.events() : '(none today)'}`)
      if (ev[0]) console.log(`  last:   ${ev[0].slice(0, 120)}...`)
      if (al[0]) console.log(`alerts:   ${al[0].slice(0, 160)}`)
      if (!alive) {
        console.log('\nstart it with:  moelog daemon    (or let your app start it at init())')
      }
      break
    }

    // -------------------------------------------------------------------- tail
    case 'tail': {
      const n = num('n', 20)
      const rows = tailLines(paths.events(), n)
      if (rows.length === 0) {
        console.log(`no events in ${paths.events()}`)
        break
      }
      for (const row of rows) {
        const rec = JSON.parse(row) as { _app: string; env: Envelope }
        for (const e of fromEnvelope(rec.env)) {
          const when = new Date(e.t).toISOString().slice(11, 23)
          const lvl = (LEVEL_NAME[e.level] ?? String(e.level)).padEnd(5)
          const at = e.frames?.[0] ? `  ${e.frames[0].file}:${e.frames[0].line}` : ''
          const ctx = e.ctx ? `  ${JSON.stringify(e.ctx)}` : ''
          console.log(`${when} ${lvl} [${rec._app}] ${e.msg}${ctx}${at}`)
        }
      }
      break
    }

    // ------------------------------------------------------------------ alerts
    case 'alerts': {
      const rows = tailLines(paths.alerts, num('n', 20))
      if (rows.length === 0) {
        console.log('no alerts. good sign.')
        break
      }
      for (const row of rows) {
        const a = JSON.parse(row) as Record<string, unknown>
        const when = new Date(Number(a['t'])).toISOString().slice(11, 19)
        const { t: _t, kind, ...rest } = a
        console.log(`${when}  ${String(kind).padEnd(20)} ${JSON.stringify(rest)}`)
      }
      break
    }

    // -------------------------------------------------------------------- stop
    case 'stop': {
      try {
        const st = JSON.parse(fs.readFileSync(paths.status, 'utf8')) as { pid: number }
        process.kill(st.pid, 'SIGTERM')
        console.log(`sidecar ${st.pid} stopped`)
      } catch {
        console.log('no sidecar registered')
      }
      break
    }

    case 'spawn': {
      console.log(
        JSON.stringify(
          spawnDaemon(paths, {
            ...(flag('server') ? { server: flag('server')! } : {}),
            ...(flag('key') ? { key: flag('key')! } : {}),
          }),
        ),
      )
      break
    }

    default:
      console.log(HELP)
  }
}

void main()
