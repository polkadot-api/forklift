import type { JsonRpcConnection } from "@polkadot-api/substrate-client";
import { forklift } from "./src/forklift";
import { createClient } from "polkadot-api";

const fork = forklift(
  {
    type: "remote",
    value: {
      url: "wss://sys.ibp.network/asset-hub-paseo",
    },
  },
  {
    disableOnIdle: true,
  }
);

// const client = createClient(fork.serve);
// const finalized = await client.getFinalizedBlock();

// await fork.newBlock({
//   unsafeBlockHeight: finalized.number + 2,
// });

const server = Bun.serve({
  fetch(req, server) {
    const success = server.upgrade(req, { data: {} as any });
    if (success) {
      // Bun automatically returns a 101 Switching Protocols
      // if the upgrade succeeds
      return undefined;
    }

    // handle HTTP request normally
    return new Response("Nothing to see here, move along");
  },
  websocket: {
    data: {} as {
      connection: JsonRpcConnection;
    },
    // this is called when a message is received
    async message(ws, message) {
      try {
        if (typeof message !== "string") throw null;
        ws.data.connection.send(JSON.parse(message));
      } catch {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32700,
              message: "Unable to parse message",
            },
          })
        );
      }
    },
    open(ws) {
      ws.data.connection = fork.serve((msg) => ws.send(JSON.stringify(msg)));
    },
    close(ws) {
      ws.data.connection.disconnect();
    },
  },
});

console.log("listening on port", server.port);
