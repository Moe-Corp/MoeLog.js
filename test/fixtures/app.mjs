/**
 * A deliberately broken app for test/failure-modes.test.ts.
 *
 *   <node|bun> app.mjs <scenario> <app-name>
 *
 * It imports the BUILT SDK of the runtime it runs on: what a user installs, not
 * the source. Plain JavaScript so both runtimes run it as-is.
 */
const isBun = typeof process.versions.bun === 'string'
const { init, log } = await import(isBun ? '../../packages/bun/dist/index.js' : '../../packages/node/dist/index.js')

const [scenario, app] = process.argv.slice(2)
init({ app, hbMs: 500 })

switch (scenario) {
  case 'crash':
    setTimeout(() => {
      throw new Error(`uncaught exception from ${app}`)
    }, 300)
    break

  case 'reject':
    setTimeout(() => void Promise.reject(new Error(`rejected promise from ${app}`)), 300)
    // Node dies on the rejection. Bun does not: give it time to report, then leave cleanly.
    setTimeout(() => process.exit(0), 1500)
    break

  case 'block':
    setTimeout(() => {
      const end = Date.now() + 3000
      while (Date.now() < end) {
        /* event loop deliberately blocked */
      }
    }, 500)
    setTimeout(() => process.exit(0), 4500)
    break

  case 'exit1':
    log('warn', 'leaving with exit code 1')
    setTimeout(() => process.exit(1), 400)
    break

  case 'clean':
    setTimeout(() => process.exit(0), 400)
    break

  case 'alive':
    // Stays up until the test kills it.
    setInterval(() => undefined, 1000)
    break

  default:
    throw new Error(`unknown scenario: ${scenario}`)
}
