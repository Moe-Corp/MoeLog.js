import fs from 'node:fs'
import path from 'node:path'
import type { Envelope } from '@moecorp/moelog-core'
import type { Paths } from './paths.ts'

/**
 * On-disk markers, written **synchronously**.
 *
 * The reason: when a process is dying there is no event loop left to push a
 * write through the socket, but a 200-byte `writeFileSync` still completes.
 * The sidecar picks the marker up when it notices the disconnect. This is what
 * guarantees the fatal error that killed the app is never lost.
 */

export interface ExitMarker {
  pid: number
  app: string
  code: number | null
  signal: string | null
  t: number
}

export interface CrashMarker {
  pid: number
  app: string
  name: string
  message: string
  stack: string | null
  origin: string
  t: number
}

function writeSync(file: string, data: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data))
  } catch {
    /* if even this fails there is nothing else to try */
  }
}

/** An envelope that never made it through the socket before the process died. */
export const writePendingMarker = (p: Paths, pid: number, env: Envelope): void =>
  writeSync(path.join(p.dataDir, `pending-${pid}.json`), env)

export const takePendingMarker = (p: Paths, pid: number): Envelope | null =>
  readAndRemove<Envelope>(path.join(p.dataDir, `pending-${pid}.json`))

export const writeExitMarker = (p: Paths, m: ExitMarker): void =>
  writeSync(p.exitMarker(m.pid), m)

export const writeCrashMarker = (p: Paths, m: CrashMarker): void =>
  writeSync(path.join(p.dataDir, `crash-${m.pid}.json`), m)

function readAndRemove<T>(file: string): T | null {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    fs.unlinkSync(file)
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export const takeExitMarker = (p: Paths, pid: number): ExitMarker | null =>
  readAndRemove<ExitMarker>(p.exitMarker(pid))

export const takeCrashMarker = (p: Paths, pid: number): CrashMarker | null =>
  readAndRemove<CrashMarker>(path.join(p.dataDir, `crash-${pid}.json`))
