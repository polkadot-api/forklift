import { Binary, type HexString } from "polkadot-api";
import { firstValueFrom } from "rxjs";
import { getParams, respond, type RpcMethod } from "./rpc_utils";

export const dev_newBlock: RpcMethod<{
  params?: {
    parent?: string;
    unsafeBlockHeight?: number;
    disableOnIdle?: boolean;
    type?: "best" | "finalized" | "fork";
  };
}> = async (con, req, { newBlock }) => {
  const { params } = getParams(req, ["params"]);
  const hash = await newBlock(params ?? {});

  con.send(respond(req, hash));
};

export const dev_setStorage: RpcMethod<{
  storageValues: Array<[HexString, HexString | null]>;
  blockHash?: HexString;
}> = async (con, req, { chain }) => {
  const { storageValues, blockHash } = getParams(req, [
    "storageValues",
    "blockHash",
  ]);

  let targetHash = blockHash ?? (await firstValueFrom(chain.best$));

  chain.setStorage(
    targetHash,
    Object.fromEntries(
      storageValues.map(([key, value]) => [
        key,
        value ? Binary.fromHex(value) : null,
      ])
    )
  );

  con.send(respond(req, targetHash));
};
