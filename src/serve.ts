import type {
  JsonRpcConnection,
  JsonRpcProvider,
} from "@polkadot-api/substrate-client";
import { Subject } from "rxjs";
import {
  chainHead_v1_body,
  chainHead_v1_call,
  chainHead_v1_follow,
  chainHead_v1_header,
  chainHead_v1_stopOperation,
  chainHead_v1_storage,
  chainHead_v1_unfollow,
  chainHead_v1_unpin,
} from "./rpc/chainHead_v1";
import {
  chainSpec_v1_chainName,
  chainSpec_v1_genesisHash,
  chainSpec_v1_properties,
} from "./rpc/chainSpec_v1";
import { dev_newBlock, dev_setStorage } from "./rpc/dev";
import type { Connection, RpcMethod, ServerContext } from "./rpc/rpc_utils";
import {
  transaction_v1_broadcast,
  transaction_v1_stop,
} from "./rpc/transaction_v1";
import type { Forklift } from "./forklift";
import type { Serve } from "bun";

export const methods: Record<string, RpcMethod> = {
  chainHead_v1_body,
  chainHead_v1_call,
  chainHead_v1_follow,
  chainHead_v1_header,
  chainHead_v1_stopOperation,
  chainHead_v1_storage,
  chainHead_v1_unfollow,
  chainHead_v1_unpin,
  chainSpec_v1_chainName,
  chainSpec_v1_genesisHash,
  chainSpec_v1_properties,
  dev_newBlock,
  dev_setStorage,
  transaction_v1_broadcast,
  transaction_v1_stop,
};

export const createServer = (ctx: ServerContext): JsonRpcProvider => {
  return (send) => {
    const disconnect = new Subject<void>();
    const con: Connection = {
      send,
      disconnect$: disconnect.asObservable(),
      context: {
        chainHead_v1_subs: {},
      },
    };

    return {
      disconnect() {},
      async send(req) {
        if (req.method === "rpc_methods") {
          return send({
            jsonrpc: "2.0",
            id: req.id!,
            result: { methods: Object.keys(methods) },
          });
        }

        const method = methods[req.method];
        if (method) {
          method(con, req, ctx);
        } else {
          console.log(req);
          send({
            jsonrpc: "2.0",
            id: req.id!,
            error: {
              code: -32601,
              message: "Method not found",
            },
          });
        }
      },
    };
  };
};

export const createWsServer = (
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
