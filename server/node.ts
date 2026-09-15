import { WebSocketServer } from "ws";
import type { Forklift } from "../src/forklift";

export interface NodeWsServer {
  port: number;
}

export const createWsServer = async (
  forklift: Forklift,
  options?: {
    port?: number | string;
  }
): Promise<NodeWsServer> => {
  let port = options?.port ? Number(options.port) : 9944;

  while (true) {
    const wsServer = new WebSocketServer({ port });

    wsServer.on("connection", (ws) => {
      const connection = forklift.serve((msg) => ws.send(JSON.stringify(msg)));

      ws.on("message", async (message) => {
        try {
          connection.send(JSON.parse(String(message)));
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
      });

      let alive = true;
      ws.on("pong", () => {
        alive = true;
      });
      const pingInterval = setInterval(() => {
        if (!alive) {
          clearInterval(pingInterval);
          ws.terminate();
          return;
        }

        alive = false;
        ws.ping();
      }, 10_000);
      ws.ping();

      ws.on("close", () => {
        connection.disconnect();
        clearInterval(pingInterval);
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: unknown) => {
          wsServer.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          wsServer.off("error", onError);
          resolve();
        };

        wsServer.once("error", onError);
        wsServer.once("listening", onListening);
      });
      const address = wsServer.address();
      return {
        port: typeof address === "object" && address ? address.port : port,
      };
    } catch (ex: any) {
      wsServer.close();
      if (ex?.code === "EADDRINUSE" && typeof port === "number") {
        port++;
        continue;
      }
      throw ex;
    }
  }
};
