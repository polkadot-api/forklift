import type { JsonRpcConnection } from "@polkadot-api/substrate-client";
import type { Serve } from "bun";
import type { Forklift } from "../src/forklift";

export const createWsServer = (
  forklift: Forklift,
  options?: Pick<
    Serve.Options<{
      connection: JsonRpcConnection;
    }>,
    "port"
  >
) => {
  const serveAtPort = (port: string | number) =>
    Bun.serve<{
      connection: JsonRpcConnection;
    }>({
      port,
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

  let port = options?.port ?? 9944;
  while (true) {
    try {
      return serveAtPort(port);
    } catch (ex: any) {
      if (ex.code === "EADDRINUSE" && typeof port === "number") {
        port++;
        continue;
      }
      throw ex;
    }
  }
};
