# @moecorp/moelog-core

The microkernel of [MoeLog](https://github.com/Moe-Corp/MoeLog.js): ring buffer, scope, hooks,
deduplication and MLWP serialization.

**Do not install this directly.** It is the shared piece; what you use in an application is
[`@moecorp/moelog-node`](https://www.npmjs.com/package/@moecorp/moelog-node) or
[`@moecorp/moelog-bun`](https://www.npmjs.com/package/@moecorp/moelog-bun).

## What it does

It is the only environment-agnostic package: it touches neither `node:*` nor the DOM. Everything
that happens at capture time lives here, and it is written to cost as little as possible:

- **Pre-allocated ring buffer** with a hard memory bound. When it fills up it sacrifices the
  oldest event of the lowest severity — a debug log never displaces an error.
- **The stack is not parsed at capture time.** The raw `Error` is kept and processed on the
  deferred path, once the thread is free. That is the difference between ~0.03 ms and ~0.4 ms per
  event.
- **Fingerprint deduplication** (FNV-1a over a normalized message): 200 identical errors arrive as
  one.
- **Zero third-party dependencies.**

## Size

4.0 kB gzipped.

## License

[AGPL-3.0-only](./LICENSE).

Note that this SDK is **imported into your application**, so the AGPL's copyleft reaches further
here than it would for a server-only project. If that is a problem for your use case, open an
issue: a permissive license for the SDKs with AGPL kept for the server is under consideration.
