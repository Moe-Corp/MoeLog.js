# @moecorp/moelog-node

The [MoeLog](https://github.com/Moe-Corp/MoeLog.js) SDK for **Node**: logs, errors and process
health, at almost no cost inside your application.

> **Alpha.** The protocol may change.

```bash
npm install @moecorp/moelog-node
```

```ts
import { init, log, error, event } from '@moecorp/moelog-node'

init({
  app: 'my-api',
  release: '1.4.2',
  server: 'http://localhost:3000',  // optional; without it, local NDJSON
  key: 'mlk_pub_…',
})

log('info', 'server up', { port: 3000 })
event('checkout.completed', { amount: 4200 })

try {
  await charge()
} catch (e) {
  error(e, { route: '/checkout' })
}
```

That is all. The sidecar starts itself the first time.

## Your app does no networking

It writes to a local unix socket and forgets. A **separate process** persists, retries and uploads
to the server. With the server switched off, emitting five errors cost **0.62 ms**, and all five
arrived once it reconnected.

Because that process lives outside and outlives your app, it is the only one that can tell you how
you died:

| Situation | Signal |
|---|---|
| Error captured by hand | level 50 event |
| Uncaught exception | `app.fatal` — with a stack, written synchronously while dying |
| **Blocked event loop** | `app.blocked` / `app.recovered` |
| **Abrupt death** (SIGKILL, OOM, panic) | `app.crashed` |
| Non-zero exit code | `app.exited_error` |
| **The app never starts** | `app.failed_to_start` (with `moelog run`) |

The three in bold cannot be reported by any SDK living inside the process.

## Why there is one package per runtime

Node and Bun differ exactly at the most delicate point, and a single package would have to lie to
one of them:

| | Node | Bun |
|---|---|---|
| Unhandled promise rejection | Becomes an uncaught exception and **kills the process** | Is printed and the process **stays alive** with exit code 0 |
| What MoeLog does | **Nothing**: `uncaughtExceptionMonitor` already sees it with a stack | **Registers the listener**: it is the only way to see it |

If you use Bun, install [`@moecorp/moelog-bun`](https://www.npmjs.com/package/@moecorp/moelog-bun). Do not install both.

## Options

| Option | Default | What it does |
|---|---|---|
| `app` · `release` · `env` | `'app'` · `'0.0.0'` · `'development'` | Context |
| `server` · `key` | — | Where the sidecar forwards. Your app never talks to that URL |
| `dataDir` | `./.moelog` | Where the sidecar lives |
| `captureGlobals` | `true` | Unhandled-error handlers |
| `hbMs` | `2000` | Heartbeat; a block is declared after 3 missed beats |
| `sampleRate` · `errorSampleRate` | `1` | Sampling |
| `maxBuffer` · `flushAt` · `flushIntervalMs` | `64` · `32` · `5000` | Buffer and triggers |
| `dedupeWindowMs` | `2000` | Fingerprint deduplication |
| `beforeSend` | — | Last chance to modify or drop an event |
| `debug` | `false` | Internal warnings |

## CLI

```bash
moelog run -- node run index.ts   # supervise: the only way to see "it never started"
moelog status · tail · alerts · stop
```

## Dependencies

Zero third-party. Only `@moecorp/moelog-core` and `@moecorp/moelog-sidecar`, from this project.

## License

[AGPL-3.0-only](./LICENSE).

Note that this SDK is **imported into your application**, so the AGPL's copyleft reaches further
here than it would for a server-only project. If that is a problem for your use case, open an
issue: a permissive license for the SDKs with AGPL kept for the server is under consideration.
