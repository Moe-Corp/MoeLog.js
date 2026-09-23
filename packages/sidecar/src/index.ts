/**
 * @moecorp/moelog-sidecar — the channel between an app and the process watching it.
 *
 * It holds BOTH ends of the channel: the client the SDK uses and the daemon
 * that listens. The per-runtime packages (`@moecorp/moelog-node`,
 * `@moecorp/moelog-bun`) build their SDK on top of this; the sidecar itself is
 * one single implementation and does not depend on the app's runtime.
 */
export { defineSdk } from './sdk.ts'
export type { RuntimeAdapter, Sdk, SdkOptions } from './sdk.ts'

export { createSidecarTransport } from './transport.ts'
export type { SidecarOptions, SidecarTransport } from './transport.ts'

export { processHealth } from './health.ts'
export type { ProcessHealthOptions } from './health.ts'

export { resolvePaths } from './paths.ts'
export type { Paths } from './paths.ts'

export {
  writeCrashMarker,
  writeExitMarker,
  writePendingMarker,
  takeCrashMarker,
  takeExitMarker,
  takePendingMarker,
} from './markers.ts'
export type { CrashMarker, ExitMarker } from './markers.ts'

export { daemonEntry, defaultRuntime, ensureDaemon, probeDaemon, spawnDaemon } from './daemon/launch.ts'
export type { RuntimeResolver, SpawnOptions, SpawnResult } from './daemon/launch.ts'

export { encode, safeParse, LineDecoder } from './protocol.ts'
export type { AlertKind, ClientMsg, DaemonMsg, Hello } from './protocol.ts'

export { VERSION } from './version.ts'
