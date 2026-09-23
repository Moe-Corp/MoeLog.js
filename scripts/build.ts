/**
 * Build with Bun. There is no bundler in `dependencies`: bun is a development
 * tool, and the published packages drag no third-party code along.
 *
 * Two rules:
 *
 *  - **Libraries** leave `@moecorp/moelog-*` external. They are real dependencies
 *    declared in their package.json; bundling them would duplicate the code in
 *    node_modules and, worse, would let two sidecars of different versions
 *    fight over the same socket.
 *  - **Executables** (the daemon) are bundled whole. The daemon is launched by
 *    a `spawn` with an absolute path, and whether it starts cannot depend on
 *    module resolution working from wherever it ended up installed.
 *
 * `__DEV__` is not defined in these builds: the configuration assertions stay
 * on and cost a single call inside `init()`. The future browser build will
 * define it as the literal `false`, and there they vanish through DCE. (Bun
 * constant-folds `process.env.*` at build time, so NODE_ENV is useless for
 * deciding anything at runtime.)
 */
import { copyFileSync, rmSync } from 'node:fs'

const ROOT = new URL('..', import.meta.url).pathname
const MOELOG = ['@moecorp/moelog-core', '@moecorp/moelog-sidecar', '@moecorp/moelog-sidecar/cli']

interface Job {
  entry: string
  outdir: string
  name: string
  external?: string[]
  banner?: string
}

const jobs: Job[] = [
  // core
  { entry: 'packages/core/src/index.ts', outdir: 'packages/core/dist', name: 'index.js' },

  // sidecar channel: library with externals, executables bundled whole
  { entry: 'packages/sidecar/src/index.ts', outdir: 'packages/sidecar/dist', name: 'index.js', external: MOELOG },
  { entry: 'packages/sidecar/src/daemon/main.ts', outdir: 'packages/sidecar/dist', name: 'daemon.js' },
  { entry: 'packages/sidecar/src/cli/main.ts', outdir: 'packages/sidecar/dist', name: 'cli.js', banner: '#!/usr/bin/env node' },

  // per-runtime SDKs
  { entry: 'packages/node/src/index.ts', outdir: 'packages/node/dist', name: 'index.js', external: MOELOG },
  { entry: 'packages/node/src/bin.ts', outdir: 'packages/node/dist', name: 'cli.js', external: MOELOG, banner: '#!/usr/bin/env node' },
  { entry: 'packages/bun/src/index.ts', outdir: 'packages/bun/dist', name: 'index.js', external: MOELOG },
  { entry: 'packages/bun/src/bin.ts', outdir: 'packages/bun/dist', name: 'cli.js', external: MOELOG, banner: '#!/usr/bin/env node' },
]

const PACKAGES = ['core', 'sidecar', 'node', 'bun'] as const

for (const pkg of PACKAGES) {
  rmSync(`${ROOT}packages/${pkg}/dist`, { recursive: true, force: true })
}

let failed = false
for (const job of jobs) {
  const out = await Bun.build({
    entrypoints: [ROOT + job.entry],
    outdir: ROOT + job.outdir,
    target: 'node',
    format: 'esm',
    naming: job.name,
    splitting: false,
    minify: false,
    sourcemap: 'linked',
    ...(job.external ? { external: job.external } : {}),
    ...(job.banner ? { banner: job.banner } : {}),
  })

  if (!out.success) {
    failed = true
    console.error(`x ${job.entry}`)
    for (const l of out.logs) console.error('  ', l.message)
    continue
  }

  const artifact = out.outputs.find((o) => o.path.endsWith(job.name))
  const bytes = artifact ? new Uint8Array(await Bun.file(artifact.path).arrayBuffer()) : new Uint8Array()
  const gz = Bun.gzipSync(bytes).length
  const tag = job.external ? 'lib ' : 'bin '
  console.log(`v ${tag}${job.outdir.replace('packages/', '')}/${job.name}`.padEnd(38) +
    `${(bytes.length / 1024).toFixed(1)} kB  (${(gz / 1024).toFixed(2)} kB gzip)`)
}

if (failed) process.exit(1)

for (const pkg of ['sidecar', 'node', 'bun']) {
  await Bun.$`chmod +x ${ROOT}packages/${pkg}/dist/cli.js`.quiet()
}

/**
 * Type declarations.
 *
 * Without these, `types` would have to point at the `.ts` source, and then
 * every consumer would compile OUR code with THEIR TypeScript configuration: an
 * older version or a different `strict` setting breaks them, and it looks like
 * our fault. A generated `.d.ts` is a closed contract.
 *
 * `skipLibCheck` because @types/node and bun-types step on each other; those
 * are their errors, not this code's.
 */
for (const pkg of PACKAGES) {
  // Arguments go in an array: inside a multi-line `$` template, Bun reads every
  // newline as a new command.
  const args = [
    '--emitDeclarationOnly', '--declaration', '--skipLibCheck',
    '--module', 'esnext', '--moduleResolution', 'bundler', '--target', 'es2022',
    '--allowImportingTsExtensions', '--strict',
    '--outDir', `${ROOT}packages/${pkg}/dist`,
    '--rootDir', `${ROOT}packages/${pkg}/src`,
    `${ROOT}packages/${pkg}/src/index.ts`,
  ]
  const r = await Bun.$`bunx tsc ${args}`.nothrow().quiet()
  const generado = await Bun.file(`${ROOT}packages/${pkg}/dist/index.d.ts`).exists()
  console.log(generado ? `v dts ${pkg}/dist/index.d.ts` : `x dts ${pkg} — ${r.stderr.toString().slice(0, 200)}`)
  if (!generado) process.exit(1)
}

/**
 * The license travels INSIDE each package.
 *
 * npm only includes the LICENSE that sits in the package folder; the monorepo
 * root does not count. The AGPL requires the text to accompany every copy of
 * the software, so this is not cosmetic. Copying it at build time avoids
 * keeping four copies in sync by hand.
 */
for (const pkg of PACKAGES) {
  copyFileSync(`${ROOT}LICENSE`, `${ROOT}packages/${pkg}/LICENSE`)
}
console.log(`v LICENSE copied into ${PACKAGES.length} packages`)
