import type { JsonRpcRequest } from "@polkadot-api/substrate-client";
import { getParams, getUuid, respond, type RpcMethod } from "./rpc_utils";
import { Binary, type HexString } from "polkadot-api";

export const transaction_v1_broadcast: RpcMethod = (
  con,
  req: JsonRpcRequest<{
    transaction: HexString;
  }>,
  { txPool }
) => {
  const { transaction } = getParams(req, ["transaction"]);

  txPool.addTx(Binary.fromHex(transaction));

  const opId = getUuid();
  return con.send(respond(req, opId));
};

export const transaction_v1_stop: RpcMethod = (con, req) =>
  con.send(respond(req, null));
