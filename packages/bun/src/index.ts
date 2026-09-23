/**
 * @moecorp/moelog-bun — the MoeLog SDK for Bun.
 *
 * Same core and same sidecar as `@moecorp/moelog-node`. What changes is what
 * Bun does differently: unhandled promise rejections (which on Bun do not kill
 * the process) and which binary is best for launching the sidecar.
 */
import { defineSdk, type SdkOptions } from '@moecorp/moelog-sidecar'
import { globalErrors, type RejectionMode } from './integrations/globalErrors.ts'
import { bunRuntime } from './runtime.ts'

export const VERSION = '0.0.2-alpha.1'

export interface BunOptions extends SdkOptions {
  /** See `RejectionMode`. Defaults to 'capture': on Bun it is the only way to see them. */
  unhandledRejections?: RejectionMode
}

const sdk = defineSdk<BunOptions>({
  sdk: `js-bun/${VERSION}`,
  runtimeTag: () => `bun/${(process.versions as Record<string, string | undefined>)['bun'] ?? '?'}`,
  daemonRuntime: bunRuntime,
  integrations: ({ paths, app, options }) => [
    globalErrors({ paths, app, mode: options.unhandledRejections ?? 'capture' }),
  ],
})

export const { init, getClient, log, error, fatal, event, flush, close } = sdk

export { globalErrors } from './integrations/globalErrors.ts'
export type { RejectionMode } from './integrations/globalErrors.ts'
export { bunRuntime, findNode } from './runtime.ts'
export { processHealth, resolvePaths } from '@moecorp/moelog-sidecar'
export type { Paths, SdkOptions } from '@moecorp/moelog-sidecar'
export { LEVEL, TYPE } from '@moecorp/moelog-core'
export type { Client, Config, Integration, Level, LevelName } from '@moecorp/moelog-core'
