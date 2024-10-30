import { WCServer } from "./index";
import { WCOpenEvent } from "./server";

const server = new WCServer(undefined, {
    useSingleLobby: true,
});

// Test regulating access to the lobby (acceptAllConnections == false)
// server.on("open", (d: WCOpenEvent) => {
//     console.log("Opened a new socket", d.request.query);

//     d.callback(d.request.query["token"] == "test");
// });