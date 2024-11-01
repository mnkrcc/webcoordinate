import { EventEmitter } from "events";
import { randomBytes } from "crypto";
import express, { Express } from "express";
import ws from "express-ws";
import cors from "cors";

export type WCConfig = {
    port?: number;
    hostname?: string;
    useSingleLobby?: boolean;
    runtimeInterval?: number;
    lobbyManageInterval?: number;
    exposeLobbiesInMetadata?: boolean;
    acceptAllConnections?: boolean;
    rejectionSocketCloseTimeout?: number;
    clientRemoveSocketCloseTimeout?: number;
    lobbyRemoveMessage?: string;
    createLobbyOnFirstClient?: boolean;
}

export type WCClient = {
    lastSynchronised: number;
    remove: (reason: string) => void;
    sendRawMessage: (message: string) => void;
}

export type WCEvent = {

}

export type WCOpenEvent = {
    request: express.Request<any>;
    callback: (shouldAccept: boolean) => void;
}

export type WCLobby = {
    id: string;
    clients: WCClient[];
    events: WCEvent[];
    runtime: NodeJS.Timeout;
}

type LobbyManageQueueItem = {
    action: "add-client" | "remove" | "query";
    data?: {
        lobbyId: string;
        client: WCClient;
    };
    cb?: (data: WCLobby) => void;
}

export class WCServer extends EventEmitter {
    private server: Express;
    private config: WCConfig;
    private wsInstance: ws.Instance;
    private lobbies: {[key: string]: WCLobby};
    private lobbyManageQueue: LobbyManageQueueItem[];
    private lobbyManageLoop: NodeJS.Timeout;

    constructor(server?: Express, config?: WCConfig) {
        super();

        this.lobbies = {};
        this.lobbyManageQueue = [];

        const defaultConfig: WCConfig = {
            port: 7750,
            hostname: "0.0.0.0",
            useSingleLobby: true,
            runtimeInterval: 10,
            exposeLobbiesInMetadata: true,
            acceptAllConnections: true,
            rejectionSocketCloseTimeout: 120,
            clientRemoveSocketCloseTimeout: 120,
            lobbyManageInterval: 100,
            lobbyRemoveMessage: "This lobby is no longer available",
            createLobbyOnFirstClient: true,
        };

        // Create a config using either the provided values or the default ones
        this.config = (config ? {
            port: config.port ?? defaultConfig.port,
            hostname: config.hostname ?? defaultConfig.hostname,
            useSingleLobby: config.useSingleLobby ?? defaultConfig.useSingleLobby,
            runtimeInterval: config.runtimeInterval ?? defaultConfig.runtimeInterval,
            exposeLobbiesInMetadata: config.exposeLobbiesInMetadata ?? defaultConfig.exposeLobbiesInMetadata,
            acceptAllConnections: config.acceptAllConnections ?? defaultConfig.acceptAllConnections,
            rejectionSocketCloseTimeout: config.rejectionSocketCloseTimeout ?? defaultConfig.rejectionSocketCloseTimeout,
            clientRemoveSocketCloseTimeout: config.clientRemoveSocketCloseTimeout ?? defaultConfig.clientRemoveSocketCloseTimeout,
            lobbyManageInterval: config.lobbyManageInterval ?? defaultConfig.lobbyManageInterval,
            lobbyRemoveMessage: config.lobbyRemoveMessage ?? defaultConfig.lobbyRemoveMessage,
            createLobbyOnFirstClient: config.createLobbyOnFirstClient ?? defaultConfig.createLobbyOnFirstClient,
        } : defaultConfig);

        this.lobbyManageLoop = setInterval(() => {
            // Dont process queue if it is empty
            if (this.lobbyManageQueue.length == 0) return;

            const item = this.lobbyManageQueue.shift()!;
            
            switch (item.action) {
                case "query":
                    if (!item.data?.lobbyId) return;

                    if (item.cb) item.cb(this.lobbies[item.data.lobbyId]);

                    break;
                case "add-client": {
                    if (!item.data?.client) return;

                    const lobby = this.lobbies[item.data.lobbyId];

                    if (!lobby) return;

                    lobby.clients.push(item.data.client);

                    if (item.cb) item.cb(lobby);

                    break;
                }
                case "remove": {
                    if (!item.data?.lobbyId) return;
                    if (!this.lobbies[item.data.lobbyId]) return;

                    for (const c of this.lobbies[item.data.lobbyId].clients) {
                        c.remove(this.config.lobbyRemoveMessage!);
                    }

                    delete(this.lobbies[item.data.lobbyId]);

                    break;
                }
            }
        }, 100);

        // Setup the only available lobby
        if (this.config.useSingleLobby) this._createLobby("main");

        // If no existing server was provided, make a new one
        this.server = server ?? express();

        this.server.use(cors());
        
        this.wsInstance = ws(this.server, undefined, {
            leaveRouterUntouched: true,
        });

        this.wsInstance.app.listen(this.config.port!, this.config.hostname!, () => {
            console.log(`[WebCoordinate] Started WC server at ${this.config.hostname}:${this.config.port}`);
        });

        this.setupRoutes();
    }

    public createLobby(lobbyId: string) {
        // If only one lobby is meant to be active, throw an error
        if (this.config.useSingleLobby)
            throw new Error("\"useSingleLobby\" was set in WCServer config, unable to create an additional lobby");

        this._createLobby(lobbyId);
    }

    private listLobbies() {
        let lobbiesList: WCLobby[] = [];

        const lobbyKeys = Object.keys(this.lobbies);

        for (const k of lobbyKeys) {
            lobbiesList.push(this.lobbies[k]);
        }

        return lobbiesList;
    }

    private async joinLobby(lobbyId: string, client: WCClient) {
        return new Promise((resolve) => {
            // TODO: Remove client from other lobbies
            client.sendRawMessage("LOB::JOINING::" + lobbyId);

            this.addLobbyQueueAction(
                "add-client",
                {
                    lobbyId,
                    client,
                },
                (lobby) => {
                    client.sendRawMessage("LOB::JOINED::" + lobbyId);

                    resolve(lobby.id == lobbyId);
                }
            );
        });
    }

    private setupRoutes() {
        const router = express.Router();

        // Setup websocket server on the webcoordinate router
        this.wsInstance.applyTo(router);

        router.get("/ping", (_, res) => {
            res.send("pong");
        });

        router.get("/meta.json", (_, res) => {
            const lobbyList = this.listLobbies();
            
            const metadataObject = {
                lobbies: this.config.exposeLobbiesInMetadata ? lobbyList.map((v) => {
                    return {
                        id: v.id,
                        activeClientCount: v.clients.length,
                    }
                }) : [],
            };

            res.send(metadataObject);
        });

        router.ws("/socket", async (ws, req) => {
            const sync = () => {
                const syncPacketId = randomBytes(3).toString("hex");
                const serverTime = new Date().getTime();

                ws.send(["SYN", syncPacketId, serverTime].join("::"));
            }

            const accept = async () => {
                const client: WCClient = {
                    lastSynchronised: -1,
                    remove: (reason: string) => {
                        ws.send(["CLS", reason].join("::"));

                        // TODO: remove any in-flight data (such as sync packets)

                        setTimeout(() => {
                            ws.close();
                        }, this.config.clientRemoveSocketCloseTimeout);
                    },
                    sendRawMessage: (message: string) => {
                        ws.send(message);
                    }
                };

                ws.onmessage = (e) => {
                    // TODO: Process messages
                }

                if (this.config.useSingleLobby) {
                    // Add this client to the main lobby
                    await this.joinLobby("main", client);
                } else if (this.listLobbies().length == 0) {
                    // Create a new lobby and join the client to it
                    const lobbyId = randomBytes(6).toString("hex");

                    this._createLobby(lobbyId);
                    await this.joinLobby(lobbyId, client);
                } else {
                    // TODO: Negotiate lobby to join
                }

                sync();
            };

            if (this.config.acceptAllConnections) await accept();

            const ev: WCOpenEvent = {
                request: req,
                callback: (shouldAccept: boolean, rejectionPayload?: string) => {
                    // Ignore the callback response if we want to accept the connection anyway
                    if (this.config.acceptAllConnections) return;
                    
                    if (!shouldAccept) {
                        ws.send(rejectionPayload ?? ["ERR", "Access Denied"].join("::"));

                        setTimeout(() => {
                            ws.close();
                        }, this.config.rejectionSocketCloseTimeout);

                        return;
                    }

                    accept();
                }
            }

            this.emit("open", ev);
        });
        
        // Add webcoordinate route to express server
        this.server.use("/.webcoordinate", router);
    }

    private addLobbyQueueAction(
        action: LobbyManageQueueItem["action"],
        data?: LobbyManageQueueItem["data"],
        cb?: LobbyManageQueueItem["cb"],
    ) {
        this.lobbyManageQueue.push({
            action,
            data,
            cb,
        });
    }

    private _createLobby(lobbyId: string) {
        const lobby: WCLobby = {
            id: lobbyId,
            clients: [],
            events: [],
            runtime: setInterval(() => {
                // TODO: Execute events when they are required to be executed
            }, this.config.runtimeInterval),
        }

        this.lobbies[lobbyId] = lobby;
    }
}