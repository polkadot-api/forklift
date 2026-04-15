import { type JsonRpcProvider } from "@polkadot-api/substrate-client";
import { Subject } from "rxjs";
import { logger } from "./logger";
import {
  archive_v1_body,
  archive_v1_call,
  archive_v1_finalizedHeight,
  archive_v1_genesisHash,
  archive_v1_hashByHeight,
  archive_v1_header,
  archive_v1_stopStorage,
  archive_v1_stopStorageDiff,
  archive_v1_storage,
  archive_v1_storageDiff,
} from "./rpc/archive_v1";
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
import {
  forklift_xcm_attach_relay,
  forklift_xcm_attach_sibling,
  forklift_xcm_consume_dmp,
  forklift_xcm_open_hrmp_channel,
  forklift_xcm_push_hrmp,
  forklift_xcm_push_ump,
} from "./rpc/forklift_xcm";
import type { Connection, RpcMethod, ServerContext } from "./rpc/rpc_utils";
import {
  transaction_v1_broadcast,
  transaction_v1_stop,
} from "./rpc/transaction_v1";

const log = logger.child({ module: "serve" });

export const methods: Record<string, RpcMethod> = {
  archive_v1_body,
  archive_v1_call,
  archive_v1_finalizedHeight,
  archive_v1_genesisHash,
  archive_v1_hashByHeight,
  archive_v1_header,
  archive_v1_stopStorage,
  archive_v1_stopStorageDiff,
  archive_v1_storage,
  archive_v1_storageDiff,
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
  forklift_xcm_attach_relay,
  forklift_xcm_attach_sibling,
  forklift_xcm_consume_dmp,
  forklift_xcm_open_hrmp_channel,
  forklift_xcm_push_hrmp,
  forklift_xcm_push_ump,
  transaction_v1_broadcast,
  transaction_v1_stop,
};

export const createServer = (
  ctx: Omit<ServerContext, "provider">
): JsonRpcProvider => {
  const provider: JsonRpcProvider = (send) => {
    const disconnect = new Subject<void>();
    const con: Connection = {
      send,
      disconnect$: disconnect.asObservable(),
      context: {
        chainHead_v1_subs: {},
        archive_v1_storage_subs: {},
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
          method(con, req, { ...ctx, provider });
        } else {
          log.warn({ method: req.method }, "unknown RPC method");
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
  return provider;
};
