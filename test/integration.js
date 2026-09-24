'use strict';

/**
 * End-to-end tests: a real HTTP server, the real `socket.io` server and the real browser client
 * (`socket.io-client`, the very bundle this package serves as `./socket.io.js`).
 *
 * These are the tests that prove the library does what an adapter embeds it for - a browser can
 * connect, subscribe and receive what the adapter publishes - and they cover the code paths that
 * only exist once all three layers are wired together: the authentication middleware, the handshake
 * parsing and the per-socket dispatch of the `publish*All` methods.
 */

const { ok, strictEqual, deepStrictEqual } = require('node:assert');

const { IOSocketClass } = require('../build');
const {
    closeHttpServer,
    createHttpServer,
    createMemoryStore,
    createMockAdapter,
    createSession,
    createToken,
    signSessionCookie,
    signSessionId,
    wait,
    waitFor,
} = require('./lib/helpers');
const { TestClient, connectClient } = require('./lib/client');

/** Secret the session cookies of these tests are signed with */
const SECRET = 'a-test-secret';

describe('integration', function () {
    this.timeout(20000);

    /** Everything that has to be torn down after a test, newest first */
    let httpServer;
    let io;
    let clients;

    beforeEach(() => {
        clients = [];
    });

    afterEach(async () => {
        for (const client of clients) {
            client.close();
        }
        clients = [];
        io?.close();
        io = null;
        await closeHttpServer(httpServer);
        httpServer = null;
    });

    /**
     * Start an HTTP server with the socket server on top of it, exactly as an adapter would.
     *
     * @param settings Socket settings (merged onto `auth: false`)
     * @param config `adapter.config`
     * @param checkUser Optional credential check, as `iobroker.web` passes it in
     */
    async function startServer(settings = {}, config = {}, checkUser) {
        httpServer = await createHttpServer();
        const port = httpServer.address().port;
        const adapter = createMockAdapter({ port, auth: !!settings.auth, ...config });
        const store = createMemoryStore();
        io = new IOSocketClass(
            httpServer,
            { auth: false, secure: false, secret: SECRET, port, ...settings },
            adapter,
            store,
            checkUser,
        );
        return { port, adapter, store };
    }

    /** The server-side socket objects, in connection order */
    function serverSockets() {
        return Object.values(io.ioServer.server.sockets.sockets);
    }

    /**
     * Connect a client that is closed automatically after the test.
     *
     * A socket.io client is "connected" as soon as the handshake is through, but the ioBroker
     * command handlers are only installed once the permissions of that socket have been calculated.
     * A command sent in between would be dropped, so wait for the ACL as well.
     */
    async function connect(port, options) {
        const client = await connectClient(port, options);
        clients.push(client);
        await waitFor(
            () => serverSockets().length >= clients.length && serverSockets().every(s => s._acl),
            'the server to finish the handshake of every client',
        );
        return client;
    }

    describe('without authentication', () => {
        it('accepts a client and answers its commands', async () => {
            const { port, adapter } = await startServer();

            const client = await connect(port);

            strictEqual(serverSockets().length, 1, 'the server must know the connected client');
            const [error, name] = await client.emit('getAdapterName');
            strictEqual(error, null);
            strictEqual(name, 'socketio');
            ok(
                adapter.logs.info.some(m => m.includes('==> Connected system.user.admin')),
                `the connection must be logged, got: ${JSON.stringify(adapter.logs.info)}`,
            );
        });

        it('serves the default user, so a browser needs no credentials', async () => {
            const { port } = await startServer({}, { defaultUser: 'admin' });

            const client = await connect(port);

            const [, acl] = await client.emit('getUserPermissions');
            strictEqual(acl.user, 'system.user.admin');
            strictEqual(serverSockets()[0]._secure, undefined, 'only an authenticated socket is marked secure');
        });

        it('publishes a state change only to the clients whose pattern matches', async () => {
            const { port } = await startServer();
            const subscribed = await connect(port);
            const other = await connect(port);
            await subscribed.emit('subscribe', 'my.0.*');
            await other.emit('subscribe', 'other.0.*');

            io.publishAll('stateChange', 'my.0.temperature', { val: 21.5, ack: true });

            const event = await subscribed.waitForEvent('stateChange');
            deepStrictEqual(event.args, ['my.0.temperature', { val: 21.5, ack: true }]);
            await wait(100);
            deepStrictEqual(other.eventsOf('stateChange'), [], 'a non-matching client must not be notified');
        });

        it('publishes a file change to the subscribed client', async () => {
            const { port } = await startServer();
            const client = await connect(port);
            await client.emit('subscribeFiles', 'vis.0', '*');

            io.publishFileAll('vis.0', 'main/vis-views.json', 4096);

            const event = await client.waitForEvent('fileChange');
            deepStrictEqual(event.args, ['vis.0', 'main/vis-views.json', 4096]);
        });

        it('delivers an instance message only to the addressed socket', async () => {
            const { port } = await startServer();
            const first = await connect(port);
            const second = await connect(port);
            await first.emit('clientSubscribe', 'cameras.0', 'snapshot');
            await second.emit('clientSubscribe', 'cameras.0', 'snapshot');

            const [firstSocket] = serverSockets();
            io.publishInstanceMessageAll('system.adapter.cameras.0', 'snapshot', firstSocket.id, { file: 'cam1.jpg' });

            const event = await first.waitForEvent('im');
            deepStrictEqual(event.args, ['snapshot', 'system.adapter.cameras.0', { file: 'cam1.jpg' }]);
            await wait(100);
            deepStrictEqual(second.eventsOf('im'), [], 'only the addressed socket may receive the message');
        });

        it('sends the log to the clients that subscribed to it', async () => {
            const { port } = await startServer();
            const subscribed = await connect(port);
            const other = await connect(port);
            const logMessage = { message: 'hello', severity: 'info', from: 'socketio.0', ts: Date.now(), _id: 1 };

            // an adapter enables the log stream for a socket itself, there is no command for it here
            serverSockets()[0].subscribe = { log: [{ pattern: '*', regex: /.*/ }] };

            io.sendLog(logMessage);

            const event = await subscribed.waitForEvent('log');
            deepStrictEqual(event.args, [logMessage]);
            deepStrictEqual(other.eventsOf('log'), [], 'a client without a log subscription must stay quiet');
        });

        it('forgets a socket when the browser disconnects', async () => {
            const { port } = await startServer();
            const client = await connect(port);
            strictEqual(serverSockets().length, 1);

            client.close();

            await waitFor(() => serverSockets().length === 0, 'the socket to be removed');
        });

        it('publishes nothing anymore after close()', async () => {
            const { port } = await startServer();
            const client = await connect(port);
            await client.emit('subscribe', '*');

            io.close();
            io = null;
            await waitFor(() => !client.connected, 'the client to notice the shutdown');

            deepStrictEqual(client.eventsOf('stateChange'), []);
        });

        it('serves a client over the polling transport as well', async () => {
            // the first request of a browser is a normal HTTP request, not a websocket upgrade
            const { port } = await startServer();

            const client = await connect(port, { transports: ['polling'] });

            const [error, name] = await client.emit('getAdapterName');
            strictEqual(error, null);
            strictEqual(name, 'socketio');
        });

        it('refuses polling when only websockets are allowed', async () => {
            const { port } = await startServer({ forceWebSockets: true });

            const client = new TestClient(port, { transports: ['polling'] });
            clients.push(client);

            await client.waitForEvent('connect_error');
            strictEqual(client.connected, false);
            strictEqual(serverSockets().length, 0);
        });
    });

    describe('with authentication', () => {
        it('turns a client without any credentials away', async () => {
            const { port, adapter } = await startServer({ auth: true }, { auth: true });

            const client = new TestClient(port);
            clients.push(client);

            await waitFor(
                () => adapter.logs.error.length,
                'the middleware to reject the handshake',
            );
            deepStrictEqual(adapter.logs.error, ['socket.io [use] Cannot detect user']);
            strictEqual(client.connected, false, 'an unauthenticated client must not be connected');
            strictEqual(serverSockets().length, 0, 'the handshake must not produce a socket');
        });

        it('accepts an access token from the query', async () => {
            const { port, store, adapter } = await startServer({ auth: true }, { auth: true });
            const token = createToken('admin');
            // the middleware reads the token from the store, `_initSocket` reads it again
            store.sessions['a:token-1'] = token;
            adapter.sessions['a:token-1'] = token;

            const client = await connect(port, { query: { access_token: 'token-1' } });

            const [, acl] = await client.emit('getUserPermissions');
            strictEqual(acl.user, 'system.user.admin');
            strictEqual(serverSockets()[0]._secure, true, 'an authenticated socket must be marked secure');
        });

        it('accepts an access token from the cookie of the handshake', async () => {
            const { port, store, adapter } = await startServer({ auth: true }, { auth: true });
            const token = createToken('admin');
            store.sessions['a:token-1'] = token;
            adapter.sessions['a:token-1'] = token;

            const client = await connect(port, { cookie: 'access_token=token-1' });

            const [, acl] = await client.emit('getUserPermissions');
            strictEqual(acl.user, 'system.user.admin');
        });

        it('accepts the signed session cookie of the web adapter', async () => {
            const { port, store, adapter } = await startServer({ auth: true }, { auth: true });
            const session = createSession('admin');
            store.sessions['session-1'] = session;
            adapter.sessions['session-1'] = session;

            const client = await connect(port, { cookie: signSessionCookie('session-1', SECRET) });

            const [, acl] = await client.emit('getUserPermissions');
            strictEqual(acl.user, 'system.user.admin');
            strictEqual(serverSockets()[0]._sessionID, 'session-1', 'the session must be kept alive later on');
        });

        it('accepts the signed session in the query', async () => {
            const { port, store, adapter } = await startServer({ auth: true }, { auth: true });
            const session = createSession('admin');
            store.sessions['session-1'] = session;
            adapter.sessions['session-1'] = session;

            const client = await connect(port, { query: { 'connect.sid': signSessionId('session-1', SECRET) } });

            const [, acl] = await client.emit('getUserPermissions');
            strictEqual(acl.user, 'system.user.admin');
        });

        it('rejects a session cookie that was signed with another secret', async () => {
            const { port, store, adapter } = await startServer({ auth: true }, { auth: true });
            store.sessions['session-1'] = createSession('admin');

            const client = new TestClient(port, { cookie: signSessionCookie('session-1', 'the-wrong-secret') });
            clients.push(client);

            await waitFor(() => adapter.logs.error.length, 'the middleware to reject the handshake');
            deepStrictEqual(adapter.logs.error, ['socket.io [use] Cannot detect user']);
            strictEqual(client.connected, false);
            deepStrictEqual(store.requested, [], 'a forged cookie must not even reach the store');
        });

        it('rejects an unknown access token', async () => {
            const { port, adapter } = await startServer({ auth: true }, { auth: true });

            const client = new TestClient(port, { query: { access_token: 'does-not-exist' } });
            clients.push(client);

            await waitFor(() => adapter.logs.error.length >= 2, 'the middleware to reject the handshake');
            // the reason is logged where it is found and again by the middleware that acts on it
            deepStrictEqual(adapter.logs.error, ['No session found', 'socket.io [use] No session found']);
            strictEqual(client.connected, false);
        });

        it('lets a user log in with name and password', async () => {
            const { port, adapter } = await startServer({ auth: true }, { auth: true });

            // the credentials travel in the query of the handshake
            const client = await connect(port, { query: { user: 'admin', pass: 'secret' } });

            const [, acl] = await client.emit('getUserPermissions');
            strictEqual(acl.user, 'system.user.admin');
            ok(adapter.logs.debug.includes('Logged in: admin'), `got: ${JSON.stringify(adapter.logs.debug)}`);
        });

        it('rejects a wrong password with an error package', async () => {
            const { port, adapter } = await startServer({ auth: true }, { auth: true });

            const client = new TestClient(port, { query: { user: 'admin', pass: 'wrong' } });
            clients.push(client);

            const event = await client.waitForEvent('error');
            strictEqual(String(event.args[0]), 'Invalid password or user name');
            strictEqual(client.connected, false);
            strictEqual(serverSockets().length, 0);
            deepStrictEqual(adapter.logs.warn, ['Invalid password or user name: admin']);
        });

        it('publishes only to the sockets of the authenticated clients', async () => {
            const { port, store, adapter } = await startServer({ auth: true }, { auth: true });
            const token = createToken('admin');
            store.sessions['a:token-1'] = token;
            adapter.sessions['a:token-1'] = token;
            const client = await connect(port, { query: { access_token: 'token-1' } });
            await client.emit('subscribe', 'my.0.*');

            io.publishAll('stateChange', 'my.0.temperature', { val: 7, ack: true });

            const event = await client.waitForEvent('stateChange');
            deepStrictEqual(event.args, ['my.0.temperature', { val: 7, ack: true }]);
        });
    });
});
