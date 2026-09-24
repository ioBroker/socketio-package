'use strict';

/**
 * A thin promise wrapper around the real browser client `socket.io-client@2`.
 *
 * The integration tests deliberately use the very client the library exists for - the package even
 * ships its browser bundle as `./socket.io.js` - instead of talking the wire protocol by hand: that
 * way a test proves that an adapter embedding `IOSocketClass` really serves a browser, not only that
 * the internal methods behave.
 */

const ioClient = require('socket.io-client');

const { DEFAULT_TIMEOUT, waitFor } = require('./helpers');

/** Events of the ioBroker socket protocol the tests look at */
const OBSERVED_EVENTS = [
    'connect',
    'disconnect',
    'error',
    'connect_error',
    'reauthenticate',
    'stateChange',
    'objectChange',
    'fileChange',
    'im',
    'log',
    'tokenInfo',
];

class TestClient {
    /**
     * @param port Port of the HTTP server the socket server is attached to
     * @param options Options for `io.connect`. `query` is not passed on but appended to the URL,
     *  which is how a browser sends credentials in the upgrade request. `cookie` becomes the cookie
     *  header of the handshake and implies the polling transport, because only the HTTP handshake
     *  carries cookies (Node's global `WebSocket` ignores extra headers).
     */
    constructor(port, options = {}) {
        /** Every event that was received, as `{ name, args }` */
        this.events = [];
        this.connected = false;

        const { query, cookie, ...connectOptions } = options;
        const search = query
            ? `?${Object.entries(query)
                  .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
                  .join('&')}`
            : '';

        this.socket = ioClient.connect(`http://127.0.0.1:${port}/${search}`, {
            // every test gets its own connection; without this the client would reuse the manager
            // of a previous test that talked to the same URL
            forceNew: true,
            // a test that closes the server on purpose must not leave a reconnect loop behind
            reconnection: false,
            timeout: DEFAULT_TIMEOUT,
            transports: cookie ? ['polling'] : ['websocket'],
            ...(cookie ? { extraHeaders: { cookie } } : {}),
            ...connectOptions,
        });

        for (const name of OBSERVED_EVENTS) {
            this.socket.on(name, (...args) => {
                if (name === 'connect') {
                    this.connected = true;
                } else if (name === 'disconnect') {
                    this.connected = false;
                }
                this.events.push({ name, args });
            });
        }
    }

    /** Names of all received events, for compact assertions */
    eventNames() {
        return this.events.map(e => e.name);
    }

    /** All events with the given name */
    eventsOf(name) {
        return this.events.filter(e => e.name === name);
    }

    /** Resolve as soon as at least `count` events with that name arrived */
    waitForEvent(name, count = 1, timeout = DEFAULT_TIMEOUT) {
        return waitFor(
            () => {
                const found = this.eventsOf(name);
                return found.length >= count ? found[count - 1] : null;
            },
            `event "${name}" #${count}`,
            timeout,
        );
    }

    /** Resolve once the client is connected (or reject after `timeout`) */
    async waitForConnect(timeout = DEFAULT_TIMEOUT) {
        await this.waitForEvent('connect', 1, timeout);
        return this;
    }

    /**
     * Send a command and resolve with all arguments the server passed to the callback.
     *
     * @returns The callback arguments as an array, e.g. `[error, result]`
     */
    emit(command, ...args) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`Timeout while waiting for answer of "${command}"`)),
                DEFAULT_TIMEOUT,
            );
            this.socket.emit(command, ...args, (...answer) => {
                clearTimeout(timer);
                resolve(answer);
            });
        });
    }

    /** Send a command without expecting an answer */
    send(command, ...args) {
        this.socket.emit(command, ...args);
    }

    /** Close the connection for good */
    close() {
        this.socket.close();
    }
}

/** Create a client and wait until it is connected */
async function connectClient(port, options) {
    const client = new TestClient(port, options);
    await client.waitForConnect();
    return client;
}

module.exports = { TestClient, connectClient, OBSERVED_EVENTS };
