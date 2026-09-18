import { WebSocketServer } from "ws";
import { createServer } from "node:http";
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
    const httpServer = createServer((req, res) => {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        });
        res.end();
        return;
      }

      res.writeHead(426, {
        "Content-Type": "text/plain",
      });
      res.end("Upgrade Required");
    });
    const wsServer = new WebSocketServer({ server: httpServer });

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

      ws.on("close", () => {
        connection.disconnect();
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: unknown) => {
          httpServer.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off("error", onError);
          resolve();
        };

        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(port);
      });
      const address = httpServer.address();
      return {
        port: typeof address === "object" && address ? address.port : port,
      };
    } catch (ex: any) {
      httpServer.close();
      if (ex?.code === "EADDRINUSE" && typeof port === "number") {
        port++;
        continue;
      }
      throw ex;
    }
  }
};
