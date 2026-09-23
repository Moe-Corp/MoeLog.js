import os from 'node:os'
import path from 'node:path'
import { hash } from '@moecorp/moelog-core'

const isWin = process.platform === 'win32'

export interface Paths {
  dataDir: string
  sock: string
  events: (d?: Date) => string
  alerts: string
  status: string
  log: string
  lock: string
  exitMarker: (pid: number) => string
}

/**
 * The socket lives in tmpdir, not in the project: unix socket paths are capped
 * at roughly 104 characters and a monorepo blows past that easily.
 */
export function resolvePaths(dataDirInput?: string): Paths {
  const dataDir = path.resolve(
    dataDirInput ?? process.env['MOELOG_DATA'] ?? path.join(process.cwd(), '.moelog'),
  )
  const id = hash(dataDir)
  const sock =
    process.env['MOELOG_SOCK'] ??
    (isWin ? `\\\\.\\pipe\\moelog-${id}` : path.join(os.tmpdir(), `moelog-${id}.sock`))

  const day = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  return {
    dataDir,
    sock,
    events: (d = new Date()) => path.join(dataDir, `events-${day(d)}.ndjson`),
    alerts: path.join(dataDir, 'alerts.ndjson'),
    status: path.join(dataDir, 'daemon.json'),
    log: path.join(dataDir, 'daemon.log'),
    lock: path.join(dataDir, 'daemon.lock'),
    exitMarker: (pid: number) => path.join(dataDir, `exit-${pid}.json`),
  }
}
