'use strict';

/**
 * Unit tests for `SocketIO`, the socket.io-specific half of `SocketCommon`.
 *
 * Everything here works on a bare instance: no real server is started (except in the `start`
 * section, which uses a fake socket.io class), and the publish helpers of the base class are
 * replaced by recorders. That keeps the tests on the code this repository actually owns - resolving
 * a user from the handshake, the session bookkeeping, the authentication middleware and the loop
 * over the connected sockets - instead of re-testing `@iobroker/socket-classes`.
 */

const path = require('node:path');
const { existsSync } = require('node:fs');
const { ok, strictEqual, deepStrictEqual, throws, match } = require('node:assert');

const { SocketIO } = require('../build');
const { SocketCommon } = require('@iobroker/socket-classes');
const {
    createAcl,
    createFakeSocket,
    createFakeSocketServer,
    createMemoryStore,
    createMockAdapter,
    createSession,
    createToken,
    signSessionCookie,
    signSessionId,
    wait,
} = require('./lib/helpers');

/** Secret the session cookies of these tests are signed with */
const SECRET = 'a-test-secret';

/** Resolve `__getUserFromSocket` into `[error, user, expirationTime]` */
function getUser(io, socket) {
    return new Promise(resolve => io.__getUserFromSocket(socket, (...args) => resolve(args)));
}

/**
 * A `SocketIO` whose authentication is initialized on a fake server, so a test can run a single
 * upgrade request through the middleware it installed.
 */
function createAuthenticated(options = {}) {
    const adapter = createMockAdapter({ auth: true }, options.adapterOverrides);
    const io = new SocketIO({ auth: true, secret: SECRET, ...options.settings }, adapter);
    io.server = createFakeSocketServer();
    const store = options.store || createMemoryStore();
    io.__initAuthentication({ store, secret: SECRET, ...options.authOptions });
    return { io, adapter, store, middleware: io.server.middlewares[0] };
}

/** Run one socket through an authentication middleware; resolves with what it passed to `next` */
function runMiddleware(middleware, socket) {
    return new Promise(resolve => middleware(socket, (...args) => resolve(args[0])));
}

/**
 * A `SocketIO` that is ready for the publish tests: it has a server with connected sockets, and the
 * publish helpers of the base class are replaced by recorders.
 *
 * @param sockets Connected clients
 * @param options Options
 * @param options.legacy Expose the clients as `sockets.connected` instead of `sockets.sockets`
 * @param options.asArray Expose the clients as an array instead of an object
 * @param options.result What the stubbed `publish*` helpers return
 */
function createPublisher(sockets, options = {}) {
    const adapter = createMockAdapter();
    const io = new SocketIO({ auth: false }, adapter);
    io.server = createFakeSocketServer(sockets, options);

    const calls = { publish: [], publishFile: [], publishInstanceMessage: [], updateSession: [] };
    const answer = typeof options.result === 'function' ? options.result : () => options.result !== false;

    io.publish = (socket, type, id, obj) => {
        calls.publish.push([socket.id, type, id, obj]);
        return answer(socket);
    };
    io.publishFile = (socket, id, fileName, size) => {
        calls.publishFile.push([socket.id, id, fileName, size]);
        return answer(socket);
    };
    io.publishInstanceMessage = (socket, sourceInstance, messageType, data) => {
        calls.publishInstanceMessage.push([socket.id, sourceInstance, messageType, data]);
        return answer(socket);
    };
    io.__updateSession = socket => {
        calls.updateSession.push(socket.id);
        return true;
    };

    return { io, adapter, calls };
}

describe('SocketIO', () => {
    describe('__getIsNoDisconnect', () => {
        it('tells the base class to leave the disconnecting to this class', () => {
            // `SocketIO` drops a socket itself (in the auth middleware and in `__updateSession`), so
            // `SocketCommon` must not close it a second time
            const io = new SocketIO({ auth: false }, createMockAdapter());
            strictEqual(io.__getIsNoDisconnect(), true);
        });
    });

    describe('__getSessionID', () => {
        it('prefers the session id the express middleware put on the request', () => {
            const io = new SocketIO({ auth: true }, createMockAdapter({ auth: true }));
            const socket = createFakeSocket('a', {
                conn: { request: { sessionID: 'from-express' } },
                _sessionID: 'from-cookie',
            });

            strictEqual(io.__getSessionID(socket), 'from-express');
        });

        it('falls back to the session id the authentication resolved', () => {
            const io = new SocketIO({ auth: true }, createMockAdapter({ auth: true }));

            strictEqual(io.__getSessionID(createFakeSocket('a', { _sessionID: 'from-cookie' })), 'from-cookie');
        });

        it('returns null when the socket has no session at all', () => {
            const io = new SocketIO({ auth: true }, createMockAdapter({ auth: true }));

            strictEqual(io.__getSessionID(createFakeSocket('a')), null);
        });
    });

    describe('__getClientAddress', () => {
        it('reports an IPv4 address of the handshake', () => {
            const io = new SocketIO({ auth: false }, createMockAdapter());

            deepStrictEqual(io.__getClientAddress(createFakeSocket('a', { handshake: { address: '192.168.1.5' } })), {
                address: '192.168.1.5',
                family: 'IPv4',
                port: 0,
            });
        });

        it('recognizes an IPv6 address by its colons', () => {
            const io = new SocketIO({ auth: false }, createMockAdapter());

            deepStrictEqual(io.__getClientAddress(createFakeSocket('a', { handshake: { address: '::1' } })), {
                address: '::1',
                family: 'IPv6',
                port: 0,
            });
        });

        it('passes an already structured address through unchanged', () => {
            const io = new SocketIO({ auth: false }, createMockAdapter());
            const address = { address: '10.0.0.1', family: 'IPv4', port: 1234 };

            strictEqual(io.__getClientAddress(createFakeSocket('a', { handshake: { address } })), address);
        });

        it('falls back to the socket of the raw request', () => {
            // a socket that was upgraded through a proxy can reach the handler without a handshake
            const io = new SocketIO({ auth: false }, createMockAdapter());
            const socket = createFakeSocket('a', {
                handshake: { address: undefined },
                request: { connection: { remoteAddress: '10.1.2.3' } },
            });

            deepStrictEqual(io.__getClientAddress(socket), { address: '10.1.2.3', family: 'IPv4', port: 0 });
        });

        it('throws when there is no address at all', () => {
            // the address decides the permissions, so a socket without one must not be served
            const io = new SocketIO({ auth: false }, createMockAdapter());
            const socket = createFakeSocket('a', { handshake: { address: undefined }, request: { connection: {} } });

            throws(() => io.__getClientAddress(socket), /Cannot detect client address/);
        });
    });

    describe('__getUserFromSocket', () => {
        /** A `SocketIO` with a store, as `__initAuthentication` would leave it */
        function createResolver(storeContent = {}, settings = {}) {
            const adapter = createMockAdapter({ auth: true });
            const io = new SocketIO({ auth: true, ...settings }, adapter);
            io.store = createMemoryStore();
            io.secret = SECRET;
            Object.assign(io.store.sessions, storeContent);
            return { io, adapter, store: io.store };
        }

        describe('access token', () => {
            it('accepts a token from the cookie header and reports its expiration', async () => {
                const token = createToken('admin');
                const { io, store } = createResolver({ 'a:token-1': token });
                const socket = createFakeSocket('a', { handshake: { headers: { cookie: 'access_token=token-1' } } });

                deepStrictEqual(await getUser(io, socket), [null, 'admin', token.aExp]);
                deepStrictEqual(store.requested, ['a:token-1'], 'the token is looked up with the "a:" prefix');
            });

            it('finds the token between other cookies', async () => {
                const token = createToken('admin');
                const { io } = createResolver({ 'a:token-1': token });
                const socket = createFakeSocket('a', {
                    handshake: { headers: { cookie: 'foo=bar; access_token=token-1; baz=1' } },
                });

                deepStrictEqual(await getUser(io, socket), [null, 'admin', token.aExp]);
            });

            it('accepts a token from the query of the upgrade request', async () => {
                // a browser that cannot set a cookie (different origin) sends it in the URL
                const token = createToken('user');
                const { io } = createResolver({ 'a:token-2': token });
                const socket = createFakeSocket('a', { request: { _query: { access_token: 'token-2' } } });

                deepStrictEqual(await getUser(io, socket), [null, 'user', token.aExp]);
            });

            it('reports a store failure instead of letting the client in', async () => {
                const { io, adapter } = createResolver();
                io.store.get = (_id, cb) => setImmediate(() => cb(new Error('store is down')));
                const socket = createFakeSocket('a', { handshake: { headers: { cookie: 'access_token=token-1' } } });

                deepStrictEqual(await getUser(io, socket), ['Cannot get token']);
                ok(adapter.logs.error.some(m => m.includes('store is down')), 'the real reason must be logged');
            });

            it('rejects a token that is not in the store', async () => {
                const { io, adapter } = createResolver();
                const socket = createFakeSocket('a', { handshake: { headers: { cookie: 'access_token=gone' } } });

                deepStrictEqual(await getUser(io, socket), ['No session found']);
                deepStrictEqual(adapter.logs.error, ['No session found']);
            });

            it('ignores the token when the client sends a user name as well', async () => {
                // an explicit login wins, so the stale token of a previous user cannot take over
                const { io, adapter } = createResolver({ 'a:token-1': createToken('admin') });
                const socket = createFakeSocket('a', {
                    handshake: { headers: { cookie: 'access_token=token-1' } },
                    request: { _query: { user: 'admin', pass: 'secret' } },
                });

                deepStrictEqual(await getUser(io, socket), [null, 'admin', 0]);
                deepStrictEqual(io.store.requested, [], 'the token must not be looked up');
                ok(adapter.logs.debug.includes('Logged in: admin'));
            });
        });

        describe('session cookie', () => {
            it('resolves the user of a signed connect.sid cookie', async () => {
                const session = createSession('admin');
                const { io, store } = createResolver({ 'session-1': session });
                const socket = createFakeSocket('a', {
                    handshake: { headers: { cookie: signSessionCookie('session-1', SECRET) } },
                });

                deepStrictEqual(await getUser(io, socket), [
                    null,
                    'admin',
                    new Date(session.cookie.expires).getTime(),
                ]);
                deepStrictEqual(store.requested, ['session-1']);
                strictEqual(socket._sessionID, 'session-1', 'the session id must be kept for __updateSession');
            });

            it('accepts the signed session in the query as well', async () => {
                // a client that cannot set a cookie passes it explicitly; socket.io has already
                // decoded the query, so the value is taken as it is
                const { io } = createResolver({ 'session-1': createSession('admin') });
                const socket = createFakeSocket('a', {
                    handshake: { query: { 'connect.sid': signSessionId('session-1', SECRET) } },
                });

                const [error, user] = await getUser(io, socket);
                strictEqual(error, null);
                strictEqual(user, 'admin');
            });

            it('url-decodes the cookie header before reading it', async () => {
                // `express-session` percent-encodes the value, because the signature is base64 and
                // its "+", "/" and "=" are not allowed in a cookie unencoded
                const { io } = createResolver({ 'session-1': createSession('admin') });
                const encoded = encodeURIComponent(signSessionId('session-1', SECRET));
                const socket = createFakeSocket('a', {
                    handshake: { headers: { cookie: `connect.sid=${encoded}` } },
                });

                ok(encoded.includes('%'), 'the test cookie must really be encoded');
                const [error, user] = await getUser(io, socket);
                strictEqual(error, null);
                strictEqual(user, 'admin');
            });

            it('reports a session without a logged-in user as unknown', async () => {
                const { io } = createResolver({ 'session-1': { cookie: {} } });
                const socket = createFakeSocket('a', {
                    handshake: { headers: { cookie: signSessionCookie('session-1', SECRET) } },
                });

                deepStrictEqual(await getUser(io, socket), ['unknown user']);
            });

            it('reports an expiration of 0 when the session cookie has none', async () => {
                const { io } = createResolver({ 'session-1': { cookie: {}, passport: { user: 'admin' } } });
                const socket = createFakeSocket('a', {
                    handshake: { headers: { cookie: signSessionCookie('session-1', SECRET) } },
                });

                deepStrictEqual(await getUser(io, socket), [null, 'admin', 0]);
            });

            it('ignores a cookie that was signed with another secret', async () => {
                // `cookie-parser` returns false for a broken signature, so the request looks like one
                // without a session - a forged cookie must never reach the store
                const { io, store } = createResolver({ 'session-1': createSession('admin') });
                const socket = createFakeSocket('a', {
                    handshake: { headers: { cookie: signSessionCookie('session-1', 'the-wrong-secret') } },
                });

                deepStrictEqual(await getUser(io, socket), ['Cannot detect user']);
                deepStrictEqual(store.requested, []);
            });

            it('ignores an unrelated cookie', async () => {
                const { io, store } = createResolver();
                const socket = createFakeSocket('a', { handshake: { headers: { cookie: 'theme=dark' } } });

                deepStrictEqual(await getUser(io, socket), ['Cannot detect user']);
                deepStrictEqual(store.requested, []);
            });
        });

        describe('user and password', () => {
            it('logs a user in with the credentials of the upgrade request', async () => {
                const { io, adapter } = createResolver();
                const socket = createFakeSocket('a', { request: { _query: { user: 'admin', pass: 'secret' } } });

                deepStrictEqual(await getUser(io, socket), [null, 'admin', 0]);
                ok(adapter.logs.debug.includes('Logged in: admin'));
            });

            it('rejects a wrong password without writing it into the log', async () => {
                const { io, adapter } = createResolver();
                const socket = createFakeSocket('a', { request: { _query: { user: 'admin', pass: 'wrong' } } });

                deepStrictEqual(await getUser(io, socket), ['unknown user_']);
                strictEqual(adapter.logs.warn.length, 1);
                match(adapter.logs.warn[0], /^Invalid password or user name: admin, w\*\*\*\(5\)$/);
            });

            it('needs both halves of the credentials', async () => {
                const { io } = createResolver();
                const socket = createFakeSocket('a', { request: { _query: { user: 'admin' } } });

                deepStrictEqual(await getUser(io, socket), ['Cannot detect user']);
            });
        });

        it('reports an anonymous socket as unknown', async () => {
            const { io } = createResolver();

            deepStrictEqual(await getUser(io, createFakeSocket('a')), ['Cannot detect user']);
        });

        it('answers even when the handshake is broken', async () => {
            // the caller waits for the callback; an exception must not make it wait forever
            const { io, adapter } = createResolver();
            const socket = createFakeSocket('a');
            socket.handshake = undefined;

            deepStrictEqual(await getUser(io, socket), ['Cannot detect user']);
            strictEqual(adapter.logs.error.length, 1, 'the exception must be logged');
        });
    });

    describe('__updateSession', () => {
        /** A `SocketIO` with a store and the session settings of an adapter */
        function createSessionHandler(settings = {}) {
            const adapter = createMockAdapter({ auth: true });
            const io = new SocketIO({ auth: true, ttl: 3600, ...settings }, adapter);
            io.store = createMemoryStore();
            return { io, adapter, store: io.store };
        }

        describe('with an access token', () => {
            it('keeps a socket whose token is still valid', () => {
                const { io, store } = createSessionHandler();
                const socket = createFakeSocket('a', { _sessionExpiresAt: Date.now() + 60_000 });

                strictEqual(io.__updateSession(socket), true);
                deepStrictEqual(store.requested, [], 'a valid token must not be looked up again');
            });

            it('rejects a socket whose token just expired, without asking the store', () => {
                // within the first 10 seconds the token is simply gone; re-reading it is pointless
                const { io, store } = createSessionHandler();
                const socket = createFakeSocket('a', { _sessionExpiresAt: Date.now() - 5_000 });

                strictEqual(io.__updateSession(socket), false);
                deepStrictEqual(store.requested, []);
            });

            it('re-reads a renewed token from the cookie and accepts the socket again', async () => {
                // the browser renews the token in the background; the socket must pick that up
                const renewed = createToken('admin');
                const { io, store } = createSessionHandler();
                store.sessions['a:token-1'] = renewed;
                const socket = createFakeSocket('a', {
                    _sessionExpiresAt: Date.now() - 20_000,
                    conn: { request: { headers: { cookie: 'access_token=token-1' } } },
                });

                strictEqual(io.__updateSession(socket), false, 'the old expiration still counts for this call');
                await wait(20);
                deepStrictEqual(store.requested, ['a:token-1']);
                strictEqual(socket._sessionExpiresAt, renewed.aExp);
                strictEqual(io.__updateSession(socket), true, 'the renewed token keeps the socket alive');
            });

            it('leaves the expiration alone when the token is gone', async () => {
                const { io, adapter } = createSessionHandler();
                const expiresAt = Date.now() - 20_000;
                const socket = createFakeSocket('a', {
                    _sessionExpiresAt: expiresAt,
                    conn: { request: { headers: { cookie: 'access_token=token-1' } } },
                });

                strictEqual(io.__updateSession(socket), false);
                await wait(20);
                strictEqual(socket._sessionExpiresAt, expiresAt);
                deepStrictEqual(adapter.logs.error, ['No session found']);
            });

            it('does not look for a token when the socket sends no cookie', async () => {
                const { io, store } = createSessionHandler();
                const socket = createFakeSocket('a', { _sessionExpiresAt: Date.now() - 20_000 });

                strictEqual(io.__updateSession(socket), false);
                await wait(20);
                deepStrictEqual(store.requested, []);
            });
        });

        describe('with a session cookie', () => {
            /** Replace `setTimeout` so a test can fire the session timer itself */
            function captureTimer(run) {
                const original = global.setTimeout;
                const timers = [];
                global.setTimeout = (cb, ms) => {
                    const handle = { cb, ms };
                    timers.push(handle);
                    return handle;
                };
                try {
                    run(timers);
                } finally {
                    global.setTimeout = original;
                }
                return timers;
            }

            it('notes the activity and arms the renewal timer', () => {
                const { io } = createSessionHandler();
                const socket = createFakeSocket('a', { _sessionID: 'session-1' });

                const timers = captureTimer(() => {
                    strictEqual(io.__updateSession(socket), true);
                });

                ok(socket._lastActivity, 'the activity must be remembered for the ttl check');
                strictEqual(timers.length, 1);
                strictEqual(timers[0].ms, 60000, 'the session is renewed at most once a minute');
            });

            it('arms the timer only once', () => {
                const { io } = createSessionHandler();
                const socket = createFakeSocket('a', { _sessionID: 'session-1' });

                const timers = captureTimer(() => {
                    io.__updateSession(socket);
                    io.__updateSession(socket);
                    io.__updateSession(socket);
                });

                strictEqual(timers.length, 1, 'every published state must not create a new timer');
            });

            it('renews the session in the ioBroker store when the timer fires', async () => {
                const { io, adapter, store } = createSessionHandler({ ttl: 900 });
                const session = createSession('admin');
                store.sessions['session-1'] = session;
                const socket = createFakeSocket('a', { _sessionID: 'session-1' });

                const timers = captureTimer(() => io.__updateSession(socket));
                timers[0].cb();
                await wait(20);

                strictEqual(socket._sessionTimer, undefined, 'the timer must be re-armable afterwards');
                deepStrictEqual(adapter.renewedSessions, [['session-1', 900]]);
                deepStrictEqual(adapter.sessions['session-1'], session);
            });

            it('asks the client to re-authenticate when the session vanished', async () => {
                const { io } = createSessionHandler();
                const socket = createFakeSocket('a', { _sessionID: 'session-1' });

                const timers = captureTimer(() => io.__updateSession(socket));
                timers[0].cb();
                await wait(20);

                deepStrictEqual(socket.emittedNames(), [SocketCommon.COMMAND_RE_AUTHENTICATE]);
                strictEqual(socket.disconnected, true);
            });

            it('drops a socket that was idle longer than the ttl', () => {
                const { io } = createSessionHandler({ ttl: 10 });
                const socket = createFakeSocket('a', {
                    _sessionID: 'session-1',
                    _lastActivity: Date.now() - 11_000,
                });

                strictEqual(io.__updateSession(socket), false);
                deepStrictEqual(socket.emittedNames(), [SocketCommon.COMMAND_RE_AUTHENTICATE]);
                strictEqual(socket.disconnected, true);
            });

            it('keeps a socket that was idle less than the ttl', () => {
                const { io } = createSessionHandler({ ttl: 3600 });
                const lastActivity = Date.now() - 10_000;
                const socket = createFakeSocket('a', { _sessionID: 'session-1', _lastActivity: lastActivity });

                strictEqual(io.__updateSession(socket), true);
                ok(socket._lastActivity > lastActivity, 'the activity must be refreshed');
                deepStrictEqual(socket.emittedNames(), []);
            });
        });

        it('accepts a socket without any session information', () => {
            // without authentication there is nothing to expire
            const adapter = createMockAdapter();
            const io = new SocketIO({ auth: false }, adapter);

            strictEqual(io.__updateSession(createFakeSocket('a')), true);
        });
    });

    describe('__initAuthentication', () => {
        it('installs exactly one middleware on the server', () => {
            const { io } = createAuthenticated();

            strictEqual(io.server.middlewares.length, 1);
            strictEqual(typeof io.server.middlewares[0], 'function');
        });

        it('keeps the secret the cookies are signed with', () => {
            const { io } = createAuthenticated();

            strictEqual(io.secret, SECRET);
        });

        it('adopts the store it was given', () => {
            const store = createMemoryStore();
            const { io } = createAuthenticated({ store });

            strictEqual(io.store, store, 'the store must be reachable for the session handling');
        });

        it('hands its own store over when none was given', () => {
            const adapter = createMockAdapter({ auth: true });
            const io = new SocketIO({ auth: true }, adapter);
            io.server = createFakeSocketServer();
            const store = createMemoryStore();
            io.store = store;

            const authOptions = { secret: SECRET, store: undefined };
            io.__initAuthentication(authOptions);

            strictEqual(authOptions.store, store, 'the caller must not be left without a store');
            strictEqual(io.store, store);
        });

        it('keeps its own store when both sides have one', () => {
            const adapter = createMockAdapter({ auth: true });
            const io = new SocketIO({ auth: true }, adapter);
            io.server = createFakeSocketServer();
            const own = createMemoryStore();
            io.store = own;

            io.__initAuthentication({ store: createMemoryStore(), secret: SECRET });

            strictEqual(io.store, own);
        });

        it('does nothing when there is no server yet', () => {
            const adapter = createMockAdapter({ auth: true });
            const io = new SocketIO({ auth: true }, adapter);

            io.__initAuthentication({ store: createMemoryStore(), secret: SECRET });

            strictEqual(io.server, null);
        });

        describe('the installed middleware', () => {
            it('lets a client with a valid session in and computes its permissions', async () => {
                const store = createMemoryStore();
                store.sessions['session-1'] = createSession('admin');
                const { middleware } = createAuthenticated({ store });
                const socket = createFakeSocket('a', {
                    _acl: undefined,
                    handshake: { headers: { cookie: signSessionCookie('session-1', SECRET) }, address: '127.0.0.1' },
                });

                strictEqual(await runMiddleware(middleware, socket), undefined, 'next() without an error');
                strictEqual(socket._secure, true, 'an authenticated socket must be marked secure');
                strictEqual(socket._acl.user, 'system.user.admin');
                deepStrictEqual(socket.emittedNames(), []);
            });

            it('narrows the permissions down to what the whitelist allows for that address', async () => {
                const store = createMemoryStore();
                store.sessions['session-1'] = createSession('admin');
                const { middleware } = createAuthenticated({
                    store,
                    settings: {
                        whiteListSettings: {
                            '127.0.0.1': {
                                user: 'user',
                                object: { read: true, list: true, write: false, delete: false },
                                state: { read: true, list: true, write: false, create: false, delete: false },
                                file: { read: true, list: true, write: false, create: false, delete: false },
                            },
                        },
                    },
                });
                const socket = createFakeSocket('a', {
                    _acl: undefined,
                    handshake: { headers: { cookie: signSessionCookie('session-1', SECRET) }, address: '127.0.0.1' },
                });

                await runMiddleware(middleware, socket);

                strictEqual(socket._acl.user, 'system.user.user', 'the whitelist replaces the user');
                strictEqual(socket._acl.state.write, false, 'a right the whitelist withholds must be gone');
                strictEqual(socket._acl.state.read, true);
            });

            it('turns an anonymous client away and never calls next()', async () => {
                const { io, adapter, middleware } = createAuthenticated();
                const socket = createFakeSocket('a', { _acl: undefined });

                const finished = await Promise.race([
                    runMiddleware(middleware, socket).then(() => 'next'),
                    wait(100).then(() => 'timeout'),
                ]);

                strictEqual(finished, 'timeout', 'the handshake must not be completed');
                deepStrictEqual(socket.emittedNames(), [SocketCommon.COMMAND_RE_AUTHENTICATE]);
                strictEqual(socket.disconnected, true);
                deepStrictEqual(adapter.logs.error, ['socket.io [use] Cannot detect user']);
                strictEqual(io.store.requested.length, 0);
            });

            it('checks a user name and password against the adapter', async () => {
                const { adapter, middleware } = createAuthenticated();
                const socket = createFakeSocket('a', {
                    _acl: undefined,
                    request: { _query: { user: 'admin', pass: 'secret' } },
                });

                strictEqual(await runMiddleware(middleware, socket), undefined);
                ok(adapter.logs.debug.includes('Logged in: admin'));
                // the permissions of this socket are computed later, by `SocketCommon._initSocket`
                strictEqual(socket._acl, undefined);
            });

            it('answers a wrong password with an error package', async () => {
                const { adapter, middleware } = createAuthenticated();
                const socket = createFakeSocket('a', {
                    _acl: undefined,
                    request: { _query: { user: 'admin', pass: 'wrong' } },
                });

                const error = await runMiddleware(middleware, socket);

                ok(error instanceof Error);
                strictEqual(error.message, 'Invalid password or user name');
                deepStrictEqual(socket.emittedNames(), [SocketCommon.COMMAND_RE_AUTHENTICATE]);
                deepStrictEqual(adapter.logs.warn, ['Invalid password or user name: admin']);
            });
        });
    });

    describe('publishAll', () => {
        it('offers the change to every connected socket', () => {
            const { io, calls } = createPublisher([createFakeSocket('a'), createFakeSocket('b')]);

            io.publishAll('stateChange', 'my.0.state', { val: 1, ack: true });

            deepStrictEqual(calls.publish, [
                ['a', 'stateChange', 'my.0.state', { val: 1, ack: true }],
                ['b', 'stateChange', 'my.0.state', { val: 1, ack: true }],
            ]);
        });

        it('refreshes the session only of the sockets that were notified', () => {
            const sockets = [createFakeSocket('a'), createFakeSocket('b')];
            // only "a" subscribed to that id
            const { io, calls } = createPublisher(sockets, { result: socket => socket.id === 'a' });

            io.publishAll('stateChange', 'my.0.state', { val: 1 });

            deepStrictEqual(calls.updateSession, ['a']);
        });

        it('also finds the sockets of an older socket.io (sockets.connected)', () => {
            const { io, calls } = createPublisher([createFakeSocket('a')], { legacy: true });

            io.publishAll('objectChange', 'my.0.obj', null);

            deepStrictEqual(calls.publish, [['a', 'objectChange', 'my.0.obj', null]]);
        });

        it('also copes with an array of sockets', () => {
            const { io, calls } = createPublisher([createFakeSocket('a')], { asArray: true });

            io.publishAll('stateChange', 'my.0.state', { val: 1 });

            deepStrictEqual(calls.publish, [['a', 'stateChange', 'my.0.state', { val: 1 }]]);
        });

        it('passes a deleted state (null) and an empty id on unchanged', () => {
            const { io, calls } = createPublisher([createFakeSocket('a')]);

            io.publishAll('stateChange', '', null);

            deepStrictEqual(calls.publish, [['a', 'stateChange', '', null]]);
        });

        it('warns and does nothing when the id is undefined', () => {
            // an undefined id matches every subscription pattern, so it must not be handed on
            const { io, adapter, calls } = createPublisher([createFakeSocket('a')]);

            io.publishAll('stateChange', undefined, { val: 1 });

            deepStrictEqual(calls.publish, []);
            deepStrictEqual(adapter.logs.warn, ['publishAll called with undefined id']);
        });

        it('does nothing when the server is gone', () => {
            const { io, calls } = createPublisher([createFakeSocket('a')]);
            io.server = null;

            io.publishAll('stateChange', 'my.0.state', { val: 1 });

            deepStrictEqual(calls.publish, []);
        });
    });

    describe('publishFileAll', () => {
        it('offers the file change to every connected socket', () => {
            const { io, calls } = createPublisher([createFakeSocket('a'), createFakeSocket('b')]);

            io.publishFileAll('vis.0', 'main/vis-views.json', 128);

            deepStrictEqual(calls.publishFile, [
                ['a', 'vis.0', 'main/vis-views.json', 128],
                ['b', 'vis.0', 'main/vis-views.json', 128],
            ]);
        });

        it('refreshes the session only of the sockets that were notified', () => {
            const sockets = [createFakeSocket('a'), createFakeSocket('b')];
            const { io, calls } = createPublisher(sockets, { result: socket => socket.id === 'b' });

            io.publishFileAll('vis.0', 'main/vis-views.json', 128);

            deepStrictEqual(calls.updateSession, ['b'], 'only a notified client keeps its session alive');
        });

        it('passes a deletion (size null) on unchanged', () => {
            const { io, calls } = createPublisher([createFakeSocket('a')]);

            io.publishFileAll('vis.0', 'main/gone.json', null);

            deepStrictEqual(calls.publishFile, [['a', 'vis.0', 'main/gone.json', null]]);
        });

        it('also finds the sockets of an older socket.io (sockets.connected)', () => {
            const { io, calls } = createPublisher([createFakeSocket('a')], { legacy: true });

            io.publishFileAll('vis.0', 'main/vis-views.json', 1);

            deepStrictEqual(calls.publishFile, [['a', 'vis.0', 'main/vis-views.json', 1]]);
        });

        it('warns and does nothing when the id is undefined', () => {
            const { io, adapter, calls } = createPublisher([createFakeSocket('a')]);

            io.publishFileAll(undefined, 'main/vis-views.json', 1);

            deepStrictEqual(calls.publishFile, []);
            deepStrictEqual(adapter.logs.warn, ['publishFileAll called with undefined id']);
        });

        it('does nothing when the server is gone', () => {
            const { io, calls } = createPublisher([createFakeSocket('a')]);
            io.server = null;

            io.publishFileAll('vis.0', 'main/vis-views.json', 1);

            deepStrictEqual(calls.publishFile, []);
        });
    });

    describe('publishInstanceMessageAll', () => {
        it('delivers only to the socket the message is addressed to', () => {
            const sockets = [createFakeSocket('a'), createFakeSocket('b'), createFakeSocket('c')];
            const { io, calls } = createPublisher(sockets);

            io.publishInstanceMessageAll('cameras.0', 'snapshot', 'b', { file: 'cam1.jpg' });

            deepStrictEqual(calls.publishInstanceMessage, [['b', 'cameras.0', 'snapshot', { file: 'cam1.jpg' }]]);
            deepStrictEqual(calls.updateSession, ['b']);
        });

        it('does not refresh the session when the client was not subscribed', () => {
            const { io, calls } = createPublisher([createFakeSocket('b')], { result: false });

            io.publishInstanceMessageAll('cameras.0', 'snapshot', 'b', []);

            deepStrictEqual(calls.publishInstanceMessage, [['b', 'cameras.0', 'snapshot', []]]);
            deepStrictEqual(calls.updateSession, []);
        });

        it('ignores an unknown socket id', () => {
            const { io, calls } = createPublisher([createFakeSocket('a')]);

            io.publishInstanceMessageAll('cameras.0', 'snapshot', 'nobody', {});

            deepStrictEqual(calls.publishInstanceMessage, []);
            deepStrictEqual(calls.updateSession, []);
        });

        it('also finds the sockets of an older socket.io (sockets.connected)', () => {
            const { io, calls } = createPublisher([createFakeSocket('a')], { legacy: true });

            io.publishInstanceMessageAll('cameras.0', 'snapshot', 'a', {});

            deepStrictEqual(calls.publishInstanceMessage, [['a', 'cameras.0', 'snapshot', {}]]);
        });

        it('does nothing when the server is gone', () => {
            const { io, calls } = createPublisher([createFakeSocket('a')]);
            io.server = null;

            io.publishInstanceMessageAll('cameras.0', 'snapshot', 'a', {});

            deepStrictEqual(calls.publishInstanceMessage, []);
        });
    });

    describe('start', () => {
        /**
         * Start a `SocketIO` on a fake socket.io class, so the test sees the options the library
         * builds and can act from inside `listen()`.
         *
         * @param settings Socket settings
         * @param socketOptions Options as `IOSocketClass` would pass them
         * @param onListen Called inside `listen()`, while `path.resolve` is still hooked
         */
        function startWithFakeClass(settings = {}, socketOptions, onListen) {
            const adapter = createMockAdapter();
            const io = new SocketIO({ auth: false, port: 1234, ...settings }, adapter);
            const server = createFakeSocketServer();
            let passedOptions;
            const socketClass = {
                listen: (_httpServer, options) => {
                    passedOptions = options;
                    onListen?.();
                    return server;
                },
            };

            io.start({}, socketClass, { store: createMemoryStore(), secret: SECRET }, socketOptions);

            return { io, adapter, server, options: passedOptions };
        }

        afterEach(() => {
            // a leaked hook would poison every following test
            ok(path.resolve('a', 'b').endsWith(`a${path.sep}b`), 'path.resolve must be the original one');
        });

        it('refuses to start without a server', () => {
            const io = new SocketIO({ auth: false }, createMockAdapter());

            throws(() => io.start(undefined), /Server cannot be empty/);
        });

        it('hands the ping settings of the caller to socket.io', () => {
            const { options } = startWithFakeClass({}, { pingInterval: 120000, pingTimeout: 30000 });

            strictEqual(options.pingInterval, 120000);
            strictEqual(options.pingTimeout, 30000);
        });

        it('falls back to its own ping settings when the caller has none', () => {
            const { options } = startWithFakeClass();

            strictEqual(options.pingInterval, 30000);
            strictEqual(options.pingTimeout, 120000);
        });

        it('names the transport cookie the way both socket.io generations read it', () => {
            // engine.io 3 and 6 both take `name` from this object and pass the object itself to
            // `cookie.serialize()`; the flat `cookieName`/`cookiePath` spelling belongs to the top
            // level of the engine.io 3 options and would produce a cookie named "undefined" here
            const { options } = startWithFakeClass();

            deepStrictEqual(options.cookie, { name: 'io', httpOnly: false, path: '/' });
        });

        it('allows the old protocol unless it is switched off', () => {
            // an old web adapter or a cached browser page still speaks engine.io 3
            strictEqual(startWithFakeClass().options.allowEIO3, true);
            strictEqual(startWithFakeClass({ compatibilityV2: true }).options.allowEIO3, true);
            strictEqual(startWithFakeClass({ compatibilityV2: false }).options.allowEIO3, undefined);
        });

        it('restricts the transports for both socket.io generations when websockets are forced', () => {
            // 4.x reads the option, 2.x has to be told afterwards through its compatibility API
            const { options, server } = startWithFakeClass({ forceWebSockets: true });

            deepStrictEqual(options.transports, ['websocket']);
            deepStrictEqual(server.settings, [['transports', ['websocket']]]);
        });

        it('leaves the transports alone by default', () => {
            const { options, server } = startWithFakeClass();

            strictEqual(options.transports, undefined);
            deepStrictEqual(server.settings, []);
        });

        it('passes the maximum message size on to socket.io 2.x', () => {
            const { server } = startWithFakeClass({}, { pingInterval: 1, pingTimeout: 1, maxHttpBufferSize: 200 });

            deepStrictEqual(server.settings, [['destroy buffer size', 200]]);
        });

        it('enables cross-domain access when it is configured', () => {
            const { server } = startWithFakeClass({ crossDomain: true });

            deepStrictEqual(server.settings, [['origins', '*:*']]);
        });

        describe('the path.resolve workaround (socketio#3555)', () => {
            it('resolves the client files inside the socket.io-client package', () => {
                // socket.io 2.x looks for its client files "upwards" instead of in its own
                // node_modules, which serves the wrong file (or none) in a hoisted install
                let resolved;
                startWithFakeClass({}, undefined, () => {
                    resolved = path.resolve('whatever', './../../', 'socket.io-client/dist/socket.io.js');
                });

                ok(existsSync(resolved), `the client bundle must exist, got: ${resolved}`);
                ok(
                    resolved.endsWith(path.normalize('socket.io-client/dist/socket.io.js')),
                    `unexpected path: ${resolved}`,
                );
            });

            it('leaves every other call to the original implementation', () => {
                let hooked;
                let original;
                startWithFakeClass({}, undefined, () => {
                    hooked = [
                        path.resolve('a', 'b'),
                        path.resolve('a', './../../', 'something-else.js'),
                        path.resolve('a', 'b', 'socket.io-client/dist/socket.io.js'),
                    ];
                });
                original = [
                    path.resolve('a', 'b'),
                    path.resolve('a', './../../', 'something-else.js'),
                    path.resolve('a', 'b', 'socket.io-client/dist/socket.io.js'),
                ];

                deepStrictEqual(hooked, original);
            });

            it('restores path.resolve afterwards', () => {
                const before = path.resolve;

                startWithFakeClass();

                strictEqual(path.resolve, before, 'the hook must not outlive start()');
            });
        });
    });
});

describe('SocketIO permissions', () => {
    it('merges an ACL with the whitelist of the client address', () => {
        // used by the authentication middleware; the whitelist may only take rights away
        const merged = SocketCommon._mergeACLs('192.168.1.7', createAcl('system.user.admin'), {
            '192.168.1.*': {
                user: 'user',
                object: { read: true, list: true, write: false, delete: false },
                state: { read: true, list: true, write: false, create: false, delete: false },
                file: { read: true, list: true, write: false, create: false, delete: false },
            },
        });

        strictEqual(merged.user, 'system.user.user');
        strictEqual(merged.object.write, false);
        strictEqual(merged.object.read, true);
    });
});
