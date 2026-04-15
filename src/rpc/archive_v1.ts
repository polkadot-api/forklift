import { blockHeader } from "@polkadot-api/substrate-bindings";
import type {
  JsonRpcMessage,
  JsonRpcRequest,
  StorageItemResponse,
} from "@polkadot-api/substrate-client";
import { Binary, type HexString } from "polkadot-api";
import {
  combineLatest,
  filter,
  firstValueFrom,
  map,
  Observable,
  Subscription,
  toArray,
} from "rxjs";
import type { Block } from "../block-builder/create-block";
import { runRuntimeCall } from "../executor";
import { resolveStorageOperation, type StorageItem } from "./chainHead_v1";
import {
  errorResponse,
  getParams,
  getUuid,
  respond,
  type RpcMethod,
} from "./rpc_utils";

type ArchiveStorageItem = {
  key: HexString;
  type:
    | "value"
    | "hash"
    | "closestDescendantMerkleValue"
    | "descendantsValues"
    | "descendantsHashes";
  paginationStartKey?: HexString;
};

const archiveStorageEvent = (
  subscription: string,
  result: any
): JsonRpcMessage => ({
  jsonrpc: "2.0",
  method: "archive_v1_storageEvent",
  params: {
    subscription,
    result,
  },
});

const getSingleParam = (req: JsonRpcRequest): string | undefined =>
  Array.isArray(req.params)
    ? req.params[0]
    : req.params && typeof req.params === "object"
    ? (Object.values(req.params)[0] as string | undefined)
    : undefined;

const sendStorageError = (
  con: Parameters<RpcMethod>[0],
  subscription: Subscription,
  subscriptionId: string,
  error: unknown
) => {
  if (subscription.closed) return;
  const message = error instanceof Error ? error.message : String(error);
  con.send(
    archiveStorageEvent(subscriptionId, {
      event: "storageError",
      error: message,
    })
  );
};

const internalError = (req: JsonRpcRequest, error: unknown) =>
  errorResponse(req, {
    code: -32603,
    message: error instanceof Error ? error.message : String(error),
  });

export const archive_v1_body: RpcMethod<{
  hash: HexString;
}> = async (con, req, { chain, source }) => {
  const { hash } = getParams(req, ["hash"]);

  const block = chain.getBlock(hash);
  if (block) {
    con.send(respond(req, block.body.map(Binary.toHex)));
    return;
  }

  try {
    const body = await source.archive?.getBody(hash);
    con.send(respond(req, body?.map(Binary.toHex) ?? null));
  } catch (error) {
    con.send(internalError(req, error));
  }
};

export const archive_v1_call: RpcMethod<{
  hash: HexString;
  function: string;
  callParameters: HexString;
}> = async (con, req, { chain, source }) => {
  const {
    hash,
    function: fnName,
    callParameters,
  } = getParams(req, ["hash", "function", "callParameters"]);

  const block = chain.getBlock(hash);
  if (block) {
    try {
      const output = await runRuntimeCall({
        chain,
        hash,
        call: fnName,
        params: callParameters,
      });
      con.send(respond(req, { success: true, value: output.result }));
    } catch (error) {
      con.send(internalError(req, error));
    }
    return;
  }

  try {
    const value = await source.archive?.call(hash, fnName, callParameters);
    con.send(respond(req, value == null ? null : { success: true, value }));
  } catch (error) {
    con.send(internalError(req, error));
  }
};

export const archive_v1_finalizedHeight: RpcMethod = async (
  con,
  req,
  { chain }
) => {
  const [finalizedHash, blocks] = await firstValueFrom(
    combineLatest([chain.finalized$, chain.blocks$])
  );
  con.send(respond(req, blocks[finalizedHash]!.header.number));
};

export const archive_v1_genesisHash: RpcMethod = async (
  con,
  req,
  { source }
) => {
  try {
    con.send(respond(req, (await source.getChainSpecData()).genesisHash));
  } catch (error) {
    con.send(internalError(req, error));
  }
};

export const archive_v1_hashByHeight: RpcMethod<{
  height: number;
}> = async (con, req, { chain, source }) => {
  const { height } = getParams(req, ["height"]);
  const [finalizedHash, blocks] = await firstValueFrom(
    combineLatest([chain.finalized$, chain.blocks$])
  );

  const finalized = blocks[finalizedHash]!;
  if (finalized.header.number < height) {
    // Get all matching blocks under finalized
    const result: HexString[] = [];
    let children = [blocks[finalizedHash]];
    while (children.length) {
      const block = children.pop()!;
      if (block.header.number === height) {
        result.push(block.hash);
      } else {
        children = [
          ...children,
          ...block.children
            .map((hash) => blocks[hash])
            .filter((v) => v != null),
        ];
      }
    }
    return con.send(respond(req, result));
  }

  // Find block
  let block: Block | undefined = finalized;
  while (block && block.header.number !== height) {
    block = blocks[block.parent];
  }
  if (block) {
    return con.send(respond(req, [block.hash]));
  }

  try {
    const result = (await source.archive?.getHashByHeight(height)) ?? [];
    con.send(respond(req, result));
  } catch (error) {
    con.send(internalError(req, error));
  }
};

export const archive_v1_header: RpcMethod<{
  hash: HexString;
}> = async (con, req, { chain, source }) => {
  const { hash } = getParams(req, ["hash"]);

  const block = chain.getBlock(hash);
  if (block) {
    con.send(respond(req, Binary.toHex(blockHeader.enc(block.header))));
    return;
  }

  try {
    const header = await source.archive?.getHeader(hash);
    con.send(
      respond(req, header ? Binary.toHex(blockHeader.enc(header)) : null)
    );
  } catch (error) {
    con.send(internalError(req, error));
  }
};

export const archive_v1_storage: RpcMethod<{
  hash: HexString;
  items: ArchiveStorageItem[];
  childTrie: HexString | null;
}> = (con, req, { chain, source }) => {
  const { hash, items, childTrie } = getParams(req, [
    "hash",
    "items",
    "childTrie",
  ]);

  if (childTrie)
    // TODO
    return con.send(
      errorResponse(req, {
        code: -1,
        message: "Child trie not implemented",
      })
    );

  const subscriptionId = getUuid();
  const subscription = new Subscription();
  con.context.archive_v1_storage_subs[subscriptionId] = subscription;
  const cleanup = () => {
    delete con.context.archive_v1_storage_subs[subscriptionId];
    subscription.unsubscribe();
  };
  con.send(respond(req, subscriptionId));

  const items$ = chain.getBlock(hash)
    ? resolveStorageOperation(chain, hash, items)
    : (() => {
        if (!source.archive) {
          throw new Error("Archive source not available");
        }

        return new Observable<StorageItemResponse>((obs) => {
          source.archive!.storageSubscription(
            hash,
            items,
            childTrie,
            (item) => obs.next(item),
            (e) => obs.error(e),
            () => obs.complete()
          );
        }).pipe(
          map((item): StorageItem => item),
          toArray(),
          filter((v) => v.length > 0)
        );
      })();

  subscription.add(
    items$.subscribe({
      next: (items) =>
        items.forEach((item) =>
          con.send(
            archiveStorageEvent(subscriptionId, {
              event: "storage",
              ...item,
            })
          )
        ),
      error: (error) => {
        sendStorageError(con, subscription, subscriptionId, error);
        cleanup();
      },
      complete: () => {
        con.send(archiveStorageEvent(subscriptionId, { event: "storageDone" }));
        cleanup();
      },
    })
  );
};

export const archive_v1_stopStorage: RpcMethod = (con, req) => {
  const subscriptionId = getSingleParam(req);
  con.send(respond(req, null));
  if (!subscriptionId) return;

  con.context.archive_v1_storage_subs[subscriptionId]?.unsubscribe();
};

export const archive_v1_storageDiff: RpcMethod = (con, req) => {
  con.send(
    errorResponse(req, {
      code: -1,
      message: "Not implemented",
    })
  );
};

export const archive_v1_stopStorageDiff: RpcMethod = (con, req) => {
  con.send(
    errorResponse(req, {
      code: -1,
      message: "Not implemented",
    })
  );
};
