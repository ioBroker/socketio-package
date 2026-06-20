import { Socket as WebSocketClient } from '@iobroker/ws-server';
import { SocketIO } from './lib/socketIO.js';
import { Socket as IOSocketClass } from './lib/socket.js';

/**
 * The exported module containing classes to initialize and utilize the
 * ioBroker socket.io based server.
 *
 * Includes:
 * - `SocketIO`: The main communication class based on socket.io.
 * - `IOSocketClass`: Wrapper class to initialize the web socket.
 * - `WebSocketClient`: The imported web socket client from `@iobroker/ws-server`.
 */
export { SocketIO, IOSocketClass, WebSocketClient };
