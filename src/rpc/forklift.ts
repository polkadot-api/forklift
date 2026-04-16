import { Binary, type HexString } from "polkadot-api";
import { getParams, respond, type RpcMethod } from "./rpc_utils";
import { mapObject } from "polkadot-api/utils";

export const forklift_getStorageDiff: RpcMethod<{
  hash: HexString;
  baseHash?: HexString;
}> = async (con, req, { chain }) => {
  const { hash, baseHash } = getParams(req, ["hash", "baseHash"]);

  const result = await chain.getStorageDiff(hash, baseHash);

  con.send(
    respond(
      req,
      mapObject(result, ({ value, prev }) => ({
        prev: prev ? Binary.toHex(prev) : null,
        value: value ? Binary.toHex(value) : null,
      }))
    )
  );
};
