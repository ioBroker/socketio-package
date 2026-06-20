// this file used by iobroker.web to start the socket
import socketio from 'socket.io';
import {
    SocketCommon,
    type SocketIoOptions,
    type SocketSettings,
    type SocketSubscribeTypes,
    type Store,
    type WhiteListSettings,
} from '@iobroker/socket-classes';
import type { SocketIO as WebSocketServer } from '@iobroker/ws-server';

import { type Server, SocketIO } from './socketIO.js';

/**
 * Socket wrapper class for ioBroker web server.
 * This class wraps the SocketIO instance and provides methods for interacting
 * with web socket clients and publishing updates to all connected clients.
 */
export class Socket {
    /**
     * The internal SocketIO server instance.
     * Can be null if the server has been closed.
     */
    public ioServer: SocketIO | null;

    /**
     * Creates a new Socket instance and initializes the socket server.
     *
     * @param server The HTTP/HTTPS server to attach socket.io to.
     * @param settings The configuration settings for the socket connection.
     * @param adapter The ioBroker adapter instance.
     * @param store An optional session store.
     * @param checkUser Optional callback for validating users by their credentials.
     */
    constructor(
        server: Server,
        settings: SocketSettings,
        adapter: ioBroker.Adapter,
        store: Store,
        checkUser?: (
            user: string,
            pass: string,
            cb: (
                error: Error | null,
                result?: {
                    logged_in: boolean;
                },
            ) => void,
        ) => void,
    ) {
        this.ioServer = new SocketIO(settings, adapter);

        const socketOptions: SocketIoOptions = {
            pingInterval: 120000,
            pingTimeout: 30000,
        };

        if (settings.forceWebSockets) {
            // socket.io 4.0
            socketOptions.transports = ['websocket'];
        }
        if (settings.compatibilityV2 !== false) {
            // socket.io 4.0
            socketOptions.allowEIO3 = true;
        }
        socketOptions.maxHttpBufferSize = 200 * 1024 * 1024; // 200 MB
        // socket.io 4.0
        // do not use it, as it overwrites the cookie
        /*socketOptions.cookie = {
            name: 'connect.sid',
            httpOnly: true,
            path: '/'
        };*/

        this.ioServer.start(
            server,
            socketio as unknown as typeof WebSocketServer,
            { store, secret: settings.secret || '', checkUser },
            socketOptions,
        );
    }

    /**
     * Retrieves the whitelist IP configured for a specific remote IP.
     *
     * @param remoteIp The IP address of the connected user.
     * @param whiteListSettings The settings object containing allowed IP blocks.
     * @returns To which default IP the given IP address corresponds, or null if denied.
     */
    getWhiteListIpForAddress(
        remoteIp: string,
        whiteListSettings: {
            [address: string]: WhiteListSettings;
        },
    ): string | null {
        return SocketCommon.getWhiteListIpForAddress(remoteIp, whiteListSettings);
    }

    /**
     * Publishes a data update to all connected clients subscribed to this event.
     *
     * @param type The type of update (e.g. stateChange, objectChange).
     * @param id The id of the state or object being updated.
     * @param obj Data value for the updated state or object.
     */
    publishAll(type: SocketSubscribeTypes, id: string, obj: ioBroker.Object | ioBroker.State | null | undefined): void {
        return this.ioServer?.publishAll(type, id, obj);
    }

    /**
     * Publishes a file update to all connected clients.
     *
     * @param id The id of the file structure.
     * @param fileName The name of the file to notify about.
     * @param size The new size of the file, or null if deleted.
     */
    publishFileAll(id: string, fileName: string, size: number | null): void {
        return this.ioServer?.publishFileAll(id, fileName, size);
    }

    /**
     * Routes an instance message to all connected clients.
     *
     * @param sourceInstance The instance that originated the message.
     * @param messageType The command or type of the message.
     * @param sid Session ID of the client (if available).
     * @param data Any data associated with the message.
     */
    publishInstanceMessageAll(sourceInstance: string, messageType: string, sid: string, data: any): void {
        return this.ioServer?.publishInstanceMessageAll(sourceInstance, messageType, sid, data);
    }

    /**
     * Broadcasts a log message object to all connected administration clients.
     *
     * @param obj The log message object wrapper.
     */
    sendLog(obj: ioBroker.LogMessage): void {
        this.ioServer?.sendLog(obj);
    }

    /**
     * Shuts down the socket.io server and closes all active connections.
     */
    close(): void {
        if (this.ioServer) {
            this.ioServer.close();
            this.ioServer = null;
        }
    }
}
