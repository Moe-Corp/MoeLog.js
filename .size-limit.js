/**
 * Byte budget per published package (PLAN §5.6). CI fails the PR when a
 * package goes over its limit.
 *
 * Measured the way a user's bundler ships it: bundled, minified, tree-shaken
 * and gzipped. Each package counts only its own code: the other @moecorp
 * packages are left out, so `core` is counted once, in `core`.
 *
 * The daemon and the CLI are not here: they run in their own process, never
 * inside the user's application.
 */
const OWN_CODE_ONLY = ['@moecorp/moelog-core', '@moecorp/moelog-sidecar', '@moecorp/moelog-sidecar/cli']

// esbuild bundles for the browser by default, where node:* does not exist.
const forNode = (config) => ({ ...config, platform: 'node', format: 'esm' })

const budget = (pkg, limit) => ({
  name: `@moecorp/moelog-${pkg}`,
  path: `packages/${pkg}/dist/index.js`,
  limit,
  gzip: true,
  ignore: OWN_CODE_ONLY,
  modifyEsbuildConfig: forNode,
})

export default [
  // PLAN §5.1: at most 4 kB on the server. The browser target (1.5 kB) belongs
  // to @moecorp/moelog-browser and gets its own entry with it.
  budget('core', '4 kB'),
  // No strict budget in the PLAN: this ceiling catches accidental bundling.
  budget('sidecar', '4 kB'),
  // Thin by design: only what each runtime does differently.
  budget('node', '1 kB'),
  budget('bun', '1.25 kB'),
]
