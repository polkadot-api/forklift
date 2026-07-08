import { Binary, type HexString } from "polkadot-api";
import { mapObject } from "polkadot-api/utils";
import { firstValueFrom } from "rxjs";
import { errorResponse, getParams, respond, type RpcMethod } from "./rpc_utils";

export const dev_newBlock: RpcMethod<{
  params?: {
    parent?: string;
    unsafeBlockHeight?: number;
    disableOnIdle?: boolean;
    storage?: Record<HexString, HexString | null>;
    transactions?: Array<HexString>;
    finalize?: boolean;
  };
}> = async (con, req, { newBlock }) => {
  const { params } = getParams(req, ["params"]);

  try {
    const hash = await newBlock(
      params
        ? {
            ...params,
            storage:
              params.storage &&
              mapObject(params.storage, (v) =>
                v == null ? null : Binary.fromHex(v)
              ),
            transactions: params.transactions?.map(Binary.fromHex),
          }
        : {}
    );

    con.send(respond(req, hash));
  } catch (ex: any) {
    con.send(
      errorResponse(req, {
        code: -1,
        message: ex.message,
      })
    );
  }
};

export const dev_setStorage: RpcMethod<{
  storageValues: Array<[HexString, HexString | null]>;
  blockHash?: HexString;
}> = async (con, req, { chain }) => {
  const { storageValues, blockHash } = getParams(req, [
    "storageValues",
    "blockHash",
  ]);

  try {
    const targetHash = blockHash ?? (await firstValueFrom(chain.best$));

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
  } catch (ex: any) {
    con.send(
      errorResponse(req, {
        code: -1,
        message: ex.message,
      })
    );
  }
};
