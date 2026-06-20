# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@iobroker/socketio-server` is a **library** (not a runnable adapter) that lets WEB applications and adapters talk to ioBroker over the `socket.io` protocol. It is consumed by `iobroker.web` and other adapters (echarts, vis, …). It was extracted from the `ioBroker.socketio` adapter.

Prefer [`@iobroker/ws-server`](https://github.com/ioBroker/ws-server-package) for new work — this package exists for socket.io-protocol compatibility.

## Commands

- **Build:** `npm run build` — runs `tsc -p tsconfig.build.json` then `node tasks.ts`. Output goes to `build/`.
- **Lint:** `npm run lint` — ESLint with `@iobroker/eslint-config`.
- **Type-check only:** `npx tsc -p tsconfig.json` — `tsconfig.json` is `noEmit` and also type-checks JS; `tsconfig.build.json` is the one that actually emits.
- **Release:** `npm run release-patch` / `release-minor` / `release-major` (via `@alcalzone/release-script`).

There is **no test suite** in this repo. CI (`.github/workflows/test-and-release.yml`) runs lint only, and deploys to npm on a `v*` tag.

`tasks.ts` is a build post-step: it copies the browser bundle `socket.io-client/dist/socket.io.js` into `build/lib/socket.io.js` so the package can serve it to clients via the `./socket.io.js` export. If you change the build output layout, keep that copy working.

## Architecture

Three source files, layered thinnest-on-top:

- **`src/index.ts`** — public API. Re-exports `SocketIO`, `IOSocketClass` (the `Socket` wrapper), and `WebSocketClient` (from `@iobroker/ws-server`).
- **`src/lib/socket.ts`** — `Socket` class, the entry point `iobroker.web` instantiates. It constructs `SocketIO`, builds the `socketOptions` (ping intervals, `forceWebSockets` → websocket-only transport, `compatibilityV2` → `allowEIO3`, 200 MB `maxHttpBufferSize`), and calls `start()`. Also exposes `publishAll` / `publishFileAll` / `publishInstanceMessageAll` / `sendLog` / `close` as pass-throughs to the server.
- **`src/lib/socketIO.ts`** — `SocketIO extends SocketCommon` (from `@iobroker/socket-classes`). This is where the real socket.io-specific logic lives.

**The key pattern:** `SocketCommon` (in the external `@iobroker/socket-classes` dependency) is the framework that handles commands and permissions. `SocketIO` implements the protocol-specific extension hooks it calls — the `__`-prefixed methods: `__getIsNoDisconnect`, `__initAuthentication`, `__getUserFromSocket`, `__getClientAddress`, `__updateSession`, `__getSessionID` — plus an override of `start()` and the `publish*All` broadcasters. Command dispatch, ACL/permission logic, and most behavior are NOT in this repo; they are in `@iobroker/socket-classes`. To understand what a connected client can actually do, read that dependency.

**Authentication** (`__getUserFromSocket` / `__initAuthentication`) resolves a user from three credential sources, in order: `access_token` (cookie or query → looked up in the session `Store`), the signed `connect.sid` session cookie (validated with `cookie-parser` + the passport session in the `Store`), and finally `user`/`pass` query params (`adapter.checkPassword`). On success it computes the ACL via `adapter.calculatePermissions` merged with the IP whitelist.

**Sessions** are kept alive by `__updateSession`, which is called after every successful publish; it re-checks token/cookie expiry and re-authenticates (emits `COMMAND_RE_AUTHENTICATE` + disconnect) when expired.

### Gotchas worth knowing before editing `socketIO.ts`

- **`start()` monkey-patches `path.resolve`** to work around socket.io@2.x looking up its client files in the wrong `node_modules` (socketio issue #3555). It saves and restores the original `path.resolve`. Do not remove or "simplify" this without understanding it — breaking it breaks client-file serving.
- This package pins **`socket.io@2.5.1`** but the code intentionally also sets 4.x-style options (`transports`, `allowEIO3`, `maxHttpBufferSize`) and has `// socket.io 2.x` / `3.x` / `4.x` comments marking version-specific branches. Leave those branches in place.
- The `SocketIoExtended` interface tacks runtime-only fields (`_secure`, `_acl`, `_sessionID`, `_lastActivity`, `_sessionTimer`) onto the socket; access goes through `as unknown as SocketIoExtended` casts. This is deliberate, not a type bug.
- `publish*All` methods handle both `server.sockets.sockets` and `server.sockets.connected` (object *or* array shapes) because the collection differs across socket.io versions.

## Conventions

- ESM only (`"type": "module"`); use `.js` extensions in relative imports (`Node16` module resolution).
- Targets Node `>=20`; TypeScript `~6.0.3`, `strict` mode.
- Every method carries a JSDoc block — match that style when adding code.
- ESLint config disables `jsdoc/require-jsdoc` and `jsdoc/require-param`; `tasks.ts` and the generated `src/lib/socket.io.js` are excluded from linting/compilation.
