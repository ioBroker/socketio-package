'use strict';

/**
 * The package is a library, so its public surface *is* the feature: an adapter must be able to
 * import exactly these names, and the package exports must point at files that the build really
 * produced (`build/lib/socket.io.js` is written by `tasks.mts`, not by `tsc`, and a broken copy step
 * would only show up in the browser of a user).
 */

const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { ok, strictEqual, deepStrictEqual } = require('node:assert');

const lib = require('../build');
const { SocketCommon } = require('@iobroker/socket-classes');
const { Socket: TransportSocket, SocketIO: TransportServer } = require('@iobroker/ws-server');

const packageJson = require('../package.json');
const root = join(__dirname, '..');

describe('public API', () => {
    it('exports SocketIO, IOSocketClass and WebSocketClient', () => {
        deepStrictEqual(Object.keys(lib).sort(), ['IOSocketClass', 'SocketIO', 'WebSocketClient']);
        strictEqual(typeof lib.SocketIO, 'function');
        strictEqual(typeof lib.IOSocketClass, 'function');
        strictEqual(typeof lib.WebSocketClient, 'function');
    });

    it('SocketIO is a SocketCommon of the socket-classes package', () => {
        ok(lib.SocketIO.prototype instanceof SocketCommon, 'SocketIO must extend SocketCommon');
    });

    it('implements every hook SocketCommon leaves to the transport', () => {
        // SocketCommon throws for the first two unless a transport implements them; the others have
        // a pure-websocket default in the base class that does not fit socket.io
        for (const hook of [
            '__getIsNoDisconnect',
            '__initAuthentication',
            '__getUserFromSocket',
            '__getClientAddress',
            '__updateSession',
            '__getSessionID',
        ]) {
            ok(
                Object.prototype.hasOwnProperty.call(lib.SocketIO.prototype, hook),
                `SocketIO must implement "${hook}"`,
            );
        }
    });

    it('broadcasts and starts through its own implementation, not the inherited one', () => {
        // socket.io keeps its clients in a different place than the ioBroker transport, so these
        // must not fall back to `SocketCommon`
        for (const method of ['start', 'publishAll', 'publishFileAll', 'publishInstanceMessageAll']) {
            ok(
                Object.prototype.hasOwnProperty.call(lib.SocketIO.prototype, method),
                `SocketIO must override "${method}"`,
            );
        }
    });

    it('WebSocketClient is the connection type of the ws transport, not of this repo', () => {
        // `@iobroker/ws-server` is a *different* package than this one; it is re-exported only so an
        // adapter can type the sockets it receives
        strictEqual(lib.WebSocketClient, TransportSocket);
        ok(TransportServer !== lib.IOSocketClass, 'IOSocketClass must not be the transport server');
    });

    it('IOSocketClass offers the facade an adapter uses', () => {
        for (const method of [
            'publishAll',
            'publishFileAll',
            'publishInstanceMessageAll',
            'sendLog',
            'close',
            'getWhiteListIpForAddress',
        ]) {
            strictEqual(typeof lib.IOSocketClass.prototype[method], 'function', `${method} must exist`);
        }
    });

    describe('package exports', () => {
        it('every exported path exists in the build', () => {
            for (const target of Object.values(packageJson.exports)) {
                const paths = typeof target === 'string' ? [target] : Object.values(target);
                for (const path of paths) {
                    ok(existsSync(join(root, path)), `${path} is exported but was not built`);
                }
            }
        });

        it('"./socket.io.js" serves the browser client', () => {
            // `tasks.mts` copies the bundled `socket.io-client` next to the compiled code so a web
            // adapter can deliver it to the browser. It must be the *same* version the server talks,
            // therefore it is copied and not re-bundled
            const served = readFileSync(join(root, packageJson.exports['./socket.io.js']));
            const clientPackage = require.resolve('socket.io-client/package.json');
            const original = readFileSync(join(clientPackage, '..', 'dist/socket.io.js'));
            deepStrictEqual(served, original, 'the served client must be the bundled socket.io-client');
        });

        it('the built entry point is the one package.json points at', () => {
            strictEqual(packageJson.main, 'build/index.js');
            strictEqual(packageJson.types, 'build/index.d.ts');
            ok(existsSync(join(root, packageJson.types)), 'the declarations must be built');
        });

        it('only ships the build and the license', () => {
            deepStrictEqual(packageJson.files, ['build/', 'LICENSE']);
        });
    });
});
