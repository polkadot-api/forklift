import type { JsonRpcProvider } from "@polkadot-api/substrate-client";
import { Subject } from "rxjs";
import type { Chain } from "./chain";
import {
  chainHead_v1_call,
  chainHead_v1_follow,
  chainHead_v1_header,
  chainHead_v1_storage,
} from "./rpc/chainHead_v1";
import type { Connection, RpcMethod } from "./rpc/rpc_utils";

const methods: Record<string, RpcMethod> = {
  chainHead_v1_follow,
  chainHead_v1_header,
  chainHead_v1_storage,
  chainHead_v1_call,
};

export const createServer = (chain: Promise<Chain>): JsonRpcProvider => {
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
            result: Object.keys(methods),
          });
        }

        const method = methods[req.method];
        if (method) {
          method(await chain, con, req);
        } else {
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
