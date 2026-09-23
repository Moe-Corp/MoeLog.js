# @moecorp/moelog-sidecar

The sidecar channel of [MoeLog](https://github.com/Moe-Corp/MoeLog.js): protocol, transport,
daemon and CLI.

**Do not install this directly.** It comes as a dependency of
[`@moecorp/moelog-node`](https://www.npmjs.com/package/@moecorp/moelog-node) and
[`@moecorp/moelog-bun`](https://www.npmjs.com/package/@moecorp/moelog-bun).

## What it is

It holds **both ends** of the channel: the client the SDK uses and the process that listens.

Your app does no networking. It writes NDJSON to a unix socket and returns. A separate process —
launched `detached`, outliving the app — persists, retries and forwards to the server.

That is what makes it possible to report three things no in-process SDK can:

- that the app died from a **SIGKILL** or a kernel OOM (reporting it would require being alive),
- that its **event loop is blocked** (reporting it would require the very loop that is blocked),
- that the app **never even started**.

Measured with the server switched off: emitting five errors cost the app **0.62 ms**, and all five
arrived on their own once it reconnected.

## CLI

Installing either SDK makes the `moelog` binary available:

```bash
moelog run -- bun run index.ts   # supervise: the only way to see "it never started"
moelog status                    # sidecar status and upstream queue
moelog tail -n 20                # latest events
moelog alerts -n 20              # crashes, blocks, failed startups
moelog stop
```

The sidecar is **one single process**, shared by every runtime: it owns a socket, and two
different versions fighting over it would be an expensive bug to debug.

## License

[AGPL-3.0-only](./LICENSE).

Note that this SDK is **imported into your application**, so the AGPL's copyleft reaches further
here than it would for a server-only project. If that is a problem for your use case, open an
issue: a permissive license for the SDKs with AGPL kept for the server is under consideration.
