'use strict';

/**
 * Shared helpers for the `@iobroker/socketio-server` tests.
 *
 * This package is only the glue between `@iobroker/socket-classes` (the protocol engine, which owns
 * the commands and the permission checks) and `socket.io@2.x` (the transport), so the tests need two
 * kinds of doubles:
 *
 *  - lightweight fakes (`createFakeSocket`, `createFakeSocketServer`) for the unit tests, which poke
 *    at a single method of `SocketIO` without starting a server at all, and
 *  - a mock `ioBroker.Adapter` plus a session store (`createMockAdapter`, `createMemoryStore`) that
 *    are complete enough to run a real HTTP server with real clients in the integration tests.
 */

const http = require('node:http');
const { createHmac } = require('node:crypto');

/** How long the integration helpers wait for an expected event before giving up */
const DEFAULT_TIMEOUT = 5000;

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wait until `check()` returns something truthy, polling every 10 ms.
 *
 * Rejects with `message` when the timeout is over, so a failing test reports what was missing
 * instead of only timing out in mocha.
 */
async function waitFor(check, message, timeout = DEFAULT_TIMEOUT) {
    const started = Date.now();
    for (;;) {
        const result = check();
        if (result) {
            return result;
        }
        if (Date.now() - started > timeout) {
            throw new Error(`Timeout while waiting for: ${message}`);
        }
        await wait(10);
    }
}

/** Full permissions, as `calculatePermissions` would return them for an admin user */
function createAcl(user = 'system.user.admin') {
    return {
        user,
        groups: ['system.group.administrator'],
        object: { read: true, list: true, write: true, delete: true },
        state: { read: true, list: true, write: true, create: true, delete: true },
        users: { create: true, write: true, delete: true },
        other: { execute: true, http: true, sendto: true },
        file: { read: true, list: true, write: true, create: true, delete: true },
    };
}

/**
 * A recording `ioBroker.Adapter` double.
 *
 * Only the members the socket classes actually touch are implemented. Every log call is kept in
 * `adapter.logs` so the tests can assert on the messages the library emits (e.g. the `socket.io
 * [use] ...` error of the authentication middleware).
 *
 * @param config `adapter.config`, i.e. the adapter `native` section
 * @param overrides Extra or replacing members, merged in last
 */
function createMockAdapter(config = {}, overrides = {}) {
    const logs = { silly: [], debug: [], info: [], warn: [], error: [] };
    const record =
        level =>
        (...args) =>
            logs[level].push(args.map(a => String(a)).join(' '));

    const adapter = {
        name: 'socketio',
        namespace: 'socketio.0',
        logs,
        /** Everything written with `setState`, as `[id, value, ack]` */
        states: [],
        /** Sessions the adapter knows about, keyed by session id */
        sessions: {},
        config: {
            port: 0,
            auth: false,
            secure: false,
            bind: '127.0.0.1',
            ttl: 3600,
            defaultUser: 'admin',
            language: 'en',
            ...config,
        },
        log: {
            level: 'debug',
            silly: record('silly'),
            debug: record('debug'),
            info: record('info'),
            warn: record('warn'),
            error: record('error'),
        },
        setState: (id, value, ack) => {
            adapter.states.push([id, value, ack]);
            return Promise.resolve();
        },
        getSession: (id, cb) => {
            setImmediate(() => cb(adapter.sessions[id]));
        },
        /** Every `setSession`, as `[id, ttl]` - the session handling renews the TTL with it */
        renewedSessions: [],
        setSession: (id, ttl, data, cb) => {
            adapter.renewedSessions.push([id, ttl]);
            adapter.sessions[id] = data;
            cb?.();
            return Promise.resolve();
        },
        destroySession: (id, cb) => {
            delete adapter.sessions[id];
            cb?.();
            return Promise.resolve();
        },
        /** Passwords the mock accepts, keyed by user name */
        passwords: { admin: 'secret' },
        checkPassword: (user, pass, cb) => {
            const ok = adapter.passwords[user] === pass;
            setImmediate(() => cb(ok, user));
            return Promise.resolve(ok);
        },
        calculatePermissions: (user, _commands, cb) => {
            const acl = createAcl(user || 'system.user.admin');
            setImmediate(() => cb(acl));
            return Promise.resolve(acl);
        },
        getForeignObjectAsync: () => Promise.resolve(null),
        getForeignObject: (_id, options, cb) => setImmediate(() => (cb || options)(null, null)),
        getObjectView: (_design, _search, _params, options, cb) =>
            setImmediate(() => (cb || options)(null, { rows: [] })),
        /** Patterns the socket classes subscribed to, as `[type, pattern]` */
        subscriptions: [],
        subscribeForeignStatesAsync: pattern => {
            adapter.subscriptions.push(['stateChange', pattern]);
            return Promise.resolve();
        },
        unsubscribeForeignStatesAsync: () => Promise.resolve(),
        subscribeForeignObjectsAsync: pattern => {
            adapter.subscriptions.push(['objectChange', pattern]);
            return Promise.resolve();
        },
        unsubscribeForeignObjectsAsync: () => Promise.resolve(),
        subscribeForeignFiles: (id, fileName) => {
            adapter.subscriptions.push(['fileChange', `${id}####${fileName}`]);
            return Promise.resolve();
        },
        unsubscribeForeignFiles: () => Promise.resolve(),
        /** Everything sent with `sendTo`, as `[instance, command, message]` */
        sentTo: [],
        sendTo: (instance, command, message, callback) => {
            adapter.sentTo.push([instance, command, message]);
            if (typeof callback === 'function') {
                setImmediate(() => callback({ result: 'ok' }));
            }
        },
        requireLog: () => Promise.resolve(),
        ...overrides,
    };

    return adapter;
}

/**
 * An in-memory session store with the `express-session` store interface the library expects
 * (`get` / `set` / `destroy`). Real deployments must use a persistent store, but for the tests this
 * is exactly what is needed - and a test can inspect or replace `store.sessions` directly.
 */
function createMemoryStore(overrides = {}) {
    const store = {
        sessions: {},
        /** Ids that were looked up, in order */
        requested: [],
        get(id, cb) {
            store.requested.push(id);
            setImmediate(() => cb(null, store.sessions[id]));
        },
        set(id, session, cb) {
            store.sessions[id] = session;
            cb?.(null);
        },
        destroy(id, cb) {
            delete store.sessions[id];
            cb?.(null);
        },
        ...overrides,
    };
    return store;
}

/**
 * A session object as `express-session` stores it.
 *
 * @param user User name without the `system.user.` prefix
 * @param expiresInMs Remaining lifetime of the cookie. A negative value produces an expired session.
 */
function createSession(user = 'admin', expiresInMs = 3600000) {
    return {
        cookie: {
            originalMaxAge: expiresInMs,
            expires: new Date(Date.now() + expiresInMs).toISOString(),
            httpOnly: true,
            path: '/',
        },
        passport: { user },
    };
}

/** An access token as the ioBroker OAuth2 endpoint stores it under `a:<token>` */
function createToken(user = 'admin', expiresInMs = 3600000) {
    return { user, aExp: Date.now() + expiresInMs };
}

/**
 * A stand-in for a connected socket.io client.
 *
 * The real socket.io socket carries the handshake twice - as `socket.handshake` (parsed by
 * socket.io) and as `socket.request` (the raw HTTP request of engine.io, with `_query`) - and
 * `SocketIO` reads from both, so the fake has to provide both as well.
 *
 * `emit` only records, so a test can assert which events the library pushed to the client without
 * running the wire protocol.
 */
function createFakeSocket(id = 'socket-1', props = {}) {
    const { handshake, request, conn, ...rest } = props;
    const socket = {
        id,
        /** Every `emit` as `{ name, args }` */
        emitted: [],
        _acl: createAcl(),
        _name: id,
        _secure: false,
        _sessionID: undefined,
        _lastActivity: undefined,
        _sessionTimer: undefined,
        subscribe: {},
        handshake: {
            query: {},
            headers: {},
            address: '127.0.0.1',
            ...handshake,
        },
        request: {
            _query: {},
            connection: { remoteAddress: '127.0.0.1' },
            ...request,
        },
        conn: {
            request: { headers: {}, sessionID: undefined },
            ...conn,
        },
        handlers: {},
        emit(name, ...args) {
            socket.emitted.push({ name, args });
        },
        /** Names of all events emitted so far, for compact assertions */
        emittedNames() {
            return socket.emitted.map(e => e.name);
        },
        on(name, cb) {
            (socket.handlers[name] ||= []).push(cb);
        },
        off() {},
        close() {
            socket.closed = true;
        },
        disconnect() {
            socket.disconnected = true;
        },
        ...rest,
    };
    return socket;
}

/**
 * A stand-in for the socket.io server.
 *
 * socket.io keeps its clients in the default namespace (`server.sockets`), where they are an object
 * keyed by socket id. Older versions offered them as `connected` instead of `sockets`, and the
 * ioBroker transport hands over an array - the `publish*All` methods cope with all of that, so the
 * helper can produce every shape.
 *
 * @param sockets Connected clients
 * @param options Options
 * @param options.legacy Expose the clients as `sockets.connected` instead of `sockets.sockets`
 * @param options.asArray Expose the clients as an array instead of an object keyed by socket id
 */
function createFakeSocketServer(sockets = [], options = {}) {
    const collection = options.asArray ? sockets : Object.fromEntries(sockets.map(s => [s.id, s]));
    const server = {
        /** Middlewares registered with `use()` */
        middlewares: [],
        handlers: {},
        /** Options set through the socket.io 2.x `set()` compatibility API, as `[key, value]` */
        settings: [],
        engine: { clientsCount: sockets.length },
        sockets: options.legacy ? { connected: collection } : { sockets: collection, connected: null },
        use(cb) {
            server.middlewares.push(cb);
            return server;
        },
        set(key, value) {
            server.settings.push([key, value]);
            return server;
        },
        on(name, cb) {
            (server.handlers[name] ||= []).push(cb);
        },
        off() {},
        close() {
            server.closed = true;
        },
    };
    return server;
}

/**
 * Sign a session id the way `express-session` does: the value is prefixed with `s:` and followed by
 * a base64 HMAC-SHA256 over it.
 *
 * `cookie-parser.signedCookie` returns `false` for a value whose signature does not match, so a test
 * cookie without a valid signature is silently ignored and the request looks like one without any
 * session at all.
 */
function signSessionId(sessionId, secret) {
    const signature = createHmac('sha256', secret).update(sessionId).digest('base64').replace(/=+$/, '');
    return `s:${sessionId}.${signature}`;
}

/** The complete `connect.sid=...` cookie for a session id */
function signSessionCookie(sessionId, secret) {
    return `connect.sid=${signSessionId(sessionId, secret)}`;
}

/** Start an HTTP server on a free port of the loopback interface */
function createHttpServer() {
    return new Promise((resolve, reject) => {
        const server = http.createServer((_req, res) => {
            res.writeHead(200);
            res.end('ok');
        });
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

/** Close an HTTP server and wait until it is really gone */
function closeHttpServer(server) {
    return new Promise(resolve => {
        if (!server?.listening) {
            resolve();
            return;
        }
        server.closeAllConnections?.();
        server.close(() => resolve());
    });
}

module.exports = {
    DEFAULT_TIMEOUT,
    closeHttpServer,
    createAcl,
    createFakeSocket,
    createFakeSocketServer,
    createHttpServer,
    createMemoryStore,
    createMockAdapter,
    createSession,
    createToken,
    signSessionCookie,
    signSessionId,
    wait,
    waitFor,
};
