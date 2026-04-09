import type { JsonRpcConnection } from "@polkadot-api/substrate-client";
import type { Forklift } from "./forklift";
import type { Serve } from "bun";

export const createServer = (
  forklift: Forklift,
  options?: Pick<
    Serve.Options<{
      connection: JsonRpcConnection;
    }>,
    "port"
  >
) =>
  Bun.serve<{
    connection: JsonRpcConnection;
  }>({
    ...options,
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
      data: {} as any,
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
        ws.data.connection = forklift.serve((msg) =>
          ws.send(JSON.stringify(msg))
        );
      },
      close(ws) {
        ws.data.connection.disconnect();
      },
    },
  });
