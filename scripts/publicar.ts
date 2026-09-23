/**
 * Publishing to the npm registry.
 *
 * Two things that are easy to get wrong by hand:
 *
 * 1. **The order.** `@moecorp/moelog-node` depends on `@moecorp/moelog-sidecar`,
 *    which depends on `@moecorp/moelog-core`. Publishing in the wrong order
 *    leaves packages nobody can install until their dependency shows up, and a
 *    broken version on npm cannot be deleted — only deprecated.
 *
 * 2. **Publish with bun, not npm.** The internal dependencies use the
 *    `workspace:*` protocol, which has to be replaced with the exact version at
 *    pack time. Bun does it; npm leaves it as-is and would publish a package
 *    that fails to install anywhere outside this repository. Verified.
 */
const PACKAGES = ['core', 'sidecar', 'node', 'bun'] as const

const agent = process.env['npm_config_user_agent'] ?? ''
if (agent.startsWith('npm')) {
  console.error(`
  This was run with npm, and it must not be.

  The internal dependencies use \`workspace:*\`. Bun replaces it with the exact
  version when packing; npm does not, and would publish a package that cannot
  be installed outside this repository.

  Use:  bun run publicar
`)
  process.exit(1)
}

const dry = process.argv.includes('--dry-run')
const ROOT = new URL('..', import.meta.url).pathname

/**
 * npm requires two-factor authentication to publish. Pass the code from your
 * authenticator app:  bun run publicar -- --otp 123456
 */
const otpFlag = process.argv.indexOf('--otp')
const otp = otpFlag >= 0 ? process.argv[otpFlag + 1] : undefined

console.log(dry ? '\n  DRY RUN — nothing is published\n' : '\n  PUBLISHING FOR REAL\n')

/**
 * Pre-flight check.
 *
 * npm rejects a publish without 2FA, but only *after* accepting the upload, so
 * without this the failure arrives buried under four screens of packed files.
 * Better to stop before touching anything.
 */
if (!dry) {
  const who = await Bun.$`bunx npm whoami`.nothrow().quiet()
  if (who.exitCode !== 0) {
    console.error('  Not logged in. Run:  bunx npm login\n')
    process.exit(1)
  }
  const profile = await Bun.$`bunx npm profile get`.nothrow().quiet()
  const tfaOff = profile.stdout.toString().includes('two-factor auth: disabled')
  if (tfaOff && !otp) {
    console.error(`
  npm requires two-factor authentication to publish.

    1. Enable it at https://www.npmjs.com/settings/~/profile  (Enable 2FA)
    2. Publish again passing the code from your authenticator app:

       bun run publicar -- --otp 123456
`)
    process.exit(1)
  }
  console.log(`  user: ${who.stdout.toString().trim()}${otp ? ' · otp provided' : ''}\n`)
}

// Always a clean build: publishing a stale dist is the classic mistake.
const build = await Bun.$`bun run ${ROOT}scripts/build.ts`.nothrow()
if (build.exitCode !== 0) {
  console.error('  the build failed, nothing is published')
  process.exit(1)
}

const published: string[] = []

for (const pkg of PACKAGES) {
  const dir = `${ROOT}packages/${pkg}`
  const manifest = await Bun.file(`${dir}/package.json`).json()
  console.log(`\n  ── ${manifest.name}@${manifest.version}`)

  // The dry run uses `bun pm pack`, not `bun publish --dry-run`: the latter
  // asks for authentication even though it uploads nothing, so it is useless
  // for reviewing the contents before you have an account.
  const r = dry
    ? await Bun.$`bun pm pack --dry-run`.cwd(dir).nothrow()
    : otp
      ? await Bun.$`bun publish --otp ${otp}`.cwd(dir).nothrow()
      : await Bun.$`bun publish`.cwd(dir).nothrow()

  if (r.exitCode !== 0) {
    if (dry) {
      console.error(`  packing ${manifest.name} failed`)
    } else {
      // Say exactly what did and did not go out. "the previous ones are
      // published" is a lie when the first one is the one that failed, and on
      // npm that distinction matters: a published version cannot be replaced.
      console.error(`\n  FAILED on ${manifest.name}`)
      console.error(
        published.length > 0
          ? `  Already published and NOT reversible: ${published.join(', ')}`
          : '  Nothing was published. The registry is untouched.',
      )
    }
    process.exit(1)
  }
  published.push(manifest.name)
}

console.log(
  dry
    ? '\n  Dry run complete. Run again without --dry-run to publish.\n'
    : '\n  Published. Check with: npm view @moecorp/moelog-node\n',
)
