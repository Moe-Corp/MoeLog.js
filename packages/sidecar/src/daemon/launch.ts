import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Paths } from '../paths.ts'

/** Resolves the daemon entry point both from `dist/` and when running `src/`. */
export function daemonEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.join(here, 'daemon.js'), // dist/daemon.js next to dist/index.js
    path.join(here, '..', 'daemon.js'), // dist/cli.js -> dist/daemon.js
    path.join(here, 'main.ts'), // src/daemon/main.ts
    path.join(here, '..', 'daemon', 'main.ts'),
  ]
  for (const c of candidates) if (fs.existsSync(c)) return c
  return candidates[0]!
}

/**
 * Which binary to launch the sidecar with.
 *
 * This package does not decide: the per-runtime SDK does, because the right
 * answer depends on the runtime. Under Node it is `process.execPath`; under Bun
 * it is better to look for a real Node and fall back to Bun if there is none.
 */
export type RuntimeResolver = (entry: string) => string

/** `MOELOG_NODE` always wins: it is the user's escape hatch. */
export const defaultRuntime: RuntimeResolver = (entry) => {
  const override = process.env['MOELOG_NODE']
  if (override) return override
  void entry
  return process.execPath
}

/** Is anyone listening on the socket? */
export function probeDaemon(sock: string, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.createConnection({ path: sock })
    const done = (v: boolean): void => {
      c.destroy()
      resolve(v)
    }
    c.on('connect', () => done(true))
    c.on('error', () => done(false))
    setTimeout(() => done(false), timeoutMs).unref()
  })
}

export interface SpawnResult {
  spawned: boolean
  reason?: string
}

export interface SpawnOptions {
  sock?: string
  runtime?: RuntimeResolver
  /** Where the sidecar forwards to. Without this it keeps the local NDJSON only. */
  server?: string
  key?: string
}

/**
 * Launches the sidecar detached. The lock keeps eight workers from starting
 * eight daemons at once.
 */
export function spawnDaemon(paths: Paths, o: SpawnOptions = {}): SpawnResult {
  const sock = o.sock ?? paths.sock
  const runtime = o.runtime ?? defaultRuntime
  try {
    fs.mkdirSync(paths.dataDir, { recursive: true })
    try {
      const st = fs.statSync(paths.lock)
      if (Date.now() - st.mtimeMs > 10_000) fs.unlinkSync(paths.lock)
    } catch {
      /* no lock present */
    }
    let fd: number
    try {
      fd = fs.openSync(paths.lock, 'wx')
    } catch {
      return { spawned: false, reason: 'another process is already starting it' }
    }
    fs.writeSync(fd, String(process.pid))
    fs.closeSync(fd)

    const entry = daemonEntry()
    const args = [entry, '--sock', sock, '--data', paths.dataDir]
    if (o.server) args.push('--server', o.server)
    if (o.key) args.push('--key', o.key)
    const child = spawn(runtime(entry), args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', () => undefined)
    // detached + unref: the sidecar outlives whoever launched it.
    child.unref()
    return { spawned: true }
  } catch (e) {
    return { spawned: false, reason: String(e) }
  }
}

/** Guarantees a live sidecar and waits until it is listening. */
export async function ensureDaemon(paths: Paths, waitMs = 3000, o: SpawnOptions = {}): Promise<boolean> {
  if (await probeDaemon(paths.sock)) return true
  spawnDaemon(paths, o)
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
    if (await probeDaemon(paths.sock)) return true
  }
  return false
}
