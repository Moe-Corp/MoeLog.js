/**
 * @moecorp/moelog-node — the MoeLog SDK for Node.
 *
 * Deliberately thin: the transport, the heartbeat and the daemon all live in
 * `@moecorp/moelog-sidecar`, which is the same for every runtime. Only what
 * Node does differently lives here.
 */
import { defaultRuntime, defineSdk, type SdkOptions } from '@moecorp/moelog-sidecar'
import { globalErrors, type RejectionMode } from './integrations/globalErrors.ts'

export const VERSION = '0.0.2-alpha.1'

export interface NodeOptions extends SdkOptions {
  /** See `RejectionMode`. Defaults to 'native': Node's semantics are untouched. */
  unhandledRejections?: RejectionMode
}

const sdk = defineSdk<NodeOptions>({
  sdk: `js-node/${VERSION}`,
  runtimeTag: () => `node/${process.versions.node}`,
  // The sidecar launches with the same binary that runs the app: it is Node already.
  daemonRuntime: defaultRuntime,
  integrations: ({ paths, app, options }) => [
    globalErrors({ paths, app, mode: options.unhandledRejections ?? 'native' }),
  ],
})

export const { init, getClient, log, error, fatal, event, flush, close } = sdk

export { globalErrors } from './integrations/globalErrors.ts'
export type { RejectionMode } from './integrations/globalErrors.ts'
export { processHealth, resolvePaths } from '@moecorp/moelog-sidecar'
export type { Paths, SdkOptions } from '@moecorp/moelog-sidecar'
export { LEVEL, TYPE } from '@moecorp/moelog-core'
export type { Client, Config, Integration, Level, LevelName } from '@moecorp/moelog-core'
