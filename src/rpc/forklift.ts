import { Binary, type HexString } from "polkadot-api";
import { mapObject } from "polkadot-api/utils";
import type { DelayMode } from "../forklift";
import { errorResponse, getParams, respond, type RpcMethod } from "./rpc_utils";

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

export const forklift_changeOptions: RpcMethod<{
  options: {
    buildBlockMode?: DelayMode;
    finalizeMode?: DelayMode;
    disableOnIdle?: boolean;
    mockSignatureHost?: boolean;
  };
}> = async (con, req, { changeOptions }) => {
  const { options } = getParams(req, ["options"]);

  changeOptions(options);

  con.send(respond(req, null));
};

export const forklift_finalize: RpcMethod<{
  hash: HexString;
}> = async (con, req, { chain }) => {
  const { hash } = getParams(req, ["hash"]);

  try {
    chain.changeFinalized(hash);
    con.send(respond(req, null));
  } catch (ex) {
    con.send(
      errorResponse(req, {
        code: -32603,
        message: "Block not readable",
      })
    );
  }
};
