import fs from 'node:fs'
import path from 'node:path'
import type { RuntimeResolver } from '@moecorp/moelog-sidecar'

let cache: string | null | undefined

/**
 * Looks for a real `node` binary on the PATH.
 *
 * The sidecar is a system process, not part of the app: it is better off
 * running on Node even when the app runs on Bun, because then it does not
 * depend on Bun being installed wherever the sidecar restarts. If there is no
 * Node, Bun itself does the job: the compiled daemon is plain ESM.
 */
export function findNode(): string | null {
  if (cache !== undefined) return cache
  const exts = process.platform === 'win32' ? ['.exe', '.cmd'] : ['']
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const full = path.join(dir, `node${ext}`)
      try {
        fs.accessSync(full, fs.constants.X_OK)
        cache = full
        return cache
      } catch {
        /* next */
      }
    }
  }
  cache = null
  return cache
}

export const bunRuntime: RuntimeResolver = (entry) => {
  const override = process.env['MOELOG_NODE']
  if (override) return override
  // A .ts entry (running from the repo, unbuilt) is only understood by Bun.
  if (entry.endsWith('.ts')) return process.execPath
  return findNode() ?? process.execPath
}
