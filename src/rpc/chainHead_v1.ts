import { blockHeader } from "@polkadot-api/substrate-bindings";
import type {
  JsonRpcMessage,
  JsonRpcRequest,
} from "@polkadot-api/substrate-client";
import type { HexString } from "polkadot-api";
import { Binary } from "polkadot-api";
import {
  combineLatest,
  filter,
  firstValueFrom,
  from,
  map,
  merge,
  pairwise,
  startWith,
  Subscription,
  withLatestFrom,
} from "rxjs";
import { finalizedAndPruned$ } from "../chain";
import { runRuntimeCall } from "../executor";
import {
  errorResponse,
  getParams,
  getUuid,
  respond,
  type RpcMethod,
} from "./rpc_utils";

const followEvent = (subscription: string, result: any): JsonRpcMessage => ({
  jsonrpc: "2.0",
  method: "chainHead_v1_followEvent",
  params: {
    subscription,
    result,
  },
});
const blockNotPinned = (req: JsonRpcRequest) =>
  errorResponse(req, {
    code: -32801,
    message: "Block not pinned",
  });
const blockNotReadable = (req: JsonRpcRequest) =>
  errorResponse(req, {
    code: -32603,
    message: "Block not readable",
  });

export const chainHead_v1_follow: RpcMethod = async (
  con,
  req: JsonRpcRequest<{
    withRuntime: boolean;
  }>,
  { chain }
) => {
  const { withRuntime } = getParams(req, ["withRuntime"]);

  const subId = getUuid();
  const ctx: (typeof con.context.chainHead_v1_subs)[string] =
    (con.context.chainHead_v1_subs[subId] = {
      pinnedBlocks: new Set<string>(),
      operations: {},
      subscription: new Subscription(),
    });
  con.send(respond(req, subId));

  const [finalized, blocks] = await firstValueFrom(
    combineLatest([chain.finalized$, chain.blocks$])
  );

  const finalizedBlockHashes = [finalized];
  ctx.pinnedBlocks.add(finalized);
  let block = finalized;
  for (let i = 0; i < 5 && blocks[block]?.parent! in blocks; i++) {
    block = blocks[block]!.parent;
    ctx.pinnedBlocks.add(block);
    finalizedBlockHashes.push(block);
  }
  finalizedBlockHashes.reverse();
  con.send(
    followEvent(subId, {
      event: "initialized",
      finalizedBlockHashes,
      finalizedBlockRuntime: withRuntime
        ? blocks[finalized]!.runtime
        : undefined,
    })
  );

  const sendChildren = (hash: HexString) => {
    const block = blocks[hash]!;
    for (const child of block.children) {
      const childBlock = blocks[child];
      if (!childBlock) {
        console.error("Child block not found", { parent: hash, child });
        continue;
      }
      ctx.pinnedBlocks.add(child);
      con.send(
        followEvent(subId, {
          event: "newBlock",
          blockHash: child,
          parentBlockHash: hash,
          newRuntime: withRuntime ? childBlock.hasNewRuntime : undefined,
        })
      );
      sendChildren(child);
    }
  };
  sendChildren(finalized);

  ctx.subscription.add(
    con.disconnect$.subscribe(() => ctx.subscription.unsubscribe())
  );

  ctx.subscription.add(
    chain.newBlocks$
      .pipe(startWith(null), pairwise(), withLatestFrom(chain.blocks$))
      .subscribe(([[prevHash, blockHash], blocks]) => {
        const block = blocks[blockHash!]!;
        if (prevHash) {
          const prevBlock = blocks[prevHash]!;
          if (block.header.number != prevBlock.header.number + 1) {
            for (const op of Object.values(ctx.operations)) {
              op.unsubscribe();
            }
            ctx.subscription.unsubscribe();
            delete con.context.chainHead_v1_subs[subId];
            con.send(
              followEvent(subId, {
                event: "stop",
              })
            );
            return;
          }
        }

        ctx.pinnedBlocks.add(blockHash!);
        con.send(
          followEvent(subId, {
            event: "newBlock",
            blockHash,
            parentBlockHash: block.parent,
            newRuntime:
              withRuntime && block.hasNewRuntime ? block.runtime : undefined,
          })
        );
      })
  );
  ctx.subscription.add(
    chain.best$.subscribe((bestBlockHash) => {
      con.send(
        followEvent(subId, { event: "bestBlockChanged", bestBlockHash })
      );
    })
  );
  ctx.subscription.add(
    finalizedAndPruned$(chain).subscribe(({ finalized, pruned }) => {
      con.send(
        followEvent(subId, {
          event: "finalized",
          finalizedBlockHashes: finalized,
          prunedBlockHashes: pruned,
        })
      );
    })
  );
};

export const chainHead_v1_unfollow: RpcMethod = async (
  con,
  req: JsonRpcRequest<{
    followSubscription: string;
  }>
) => {
  const { followSubscription } = getParams(req, ["followSubscription"]);

  const followSub = con.context.chainHead_v1_subs[followSubscription];
  con.send(respond(req, null));

  if (!followSub) return;
  for (const op of Object.values(followSub.operations)) {
    op.unsubscribe();
  }
  followSub.subscription.unsubscribe();
  delete con.context.chainHead_v1_subs[followSubscription];
};

export const chainHead_v1_header: RpcMethod = (
  con,
  req: JsonRpcRequest<{
    followSubscription: string;
    hash: string;
  }>,
  { chain }
) => {
  const { followSubscription, hash } = getParams(req, [
    "followSubscription",
    "hash",
  ]);

  const sub = con.context.chainHead_v1_subs[followSubscription];
  if (!sub) return con.send(respond(req, null));

  if (!sub.pinnedBlocks.has(hash)) return con.send(blockNotPinned(req));

  const block = chain.getBlock(hash);
  if (!block) return con.send(blockNotReadable(req));

  con.send(respond(req, Binary.toHex(blockHeader.enc(block.header))));
};

export const chainHead_v1_storage: RpcMethod = (
  con,
  req: JsonRpcRequest<{
    followSubscription: string;
    hash: HexString;
    items: Array<{
      key: HexString;
      type:
        | "value"
        | "hash"
        | "closestDescendantMerkleValue"
        | "descendantsValues"
        | "descendantsHashes";
    }>;
    childTrie: HexString | null;
  }>,
  { chain }
) => {
  const { followSubscription, hash, items, childTrie } = getParams(req, [
    "followSubscription",
    "hash",
    "items",
    "childTrie",
  ]);

  const sub = con.context.chainHead_v1_subs[followSubscription];
  if (!sub) return con.send(respond(req, { result: "limitReached" }));

  if (!sub.pinnedBlocks.has(hash)) return con.send(blockNotPinned(req));

  if (childTrie)
    // TODO
    return con.send(blockNotReadable(req));

  const block = chain.getBlock(hash);
  if (!block) return con.send(blockNotReadable(req));

  const opId = getUuid();
  const subscription = new Subscription();
  sub.operations[opId] = subscription;
  const cleanup = () => {
    delete sub.operations[opId];
    subscription.unsubscribe();
  };

  con.send(
    respond(req, {
      result: "started",
      operationId: opId,
      discardedItems: [],
    })
  );

  const nodeQueries = items.filter(
    (it) =>
      it.type === "closestDescendantMerkleValue" ||
      it.type === "hash" ||
      it.type === "value"
  );
  type StorageItem = {
    key: HexString;
    value?: HexString;
    hash?: HexString;
    closestDescendantMerkleValue?: HexString;
  };

  // TODO pagination
  const nodeQueries$ = from(
    nodeQueries.length
      ? chain.getStorageBatch(
          hash,
          nodeQueries.map((it) => it.key)
        )
      : []
  ).pipe(
    map((nodes) =>
      nodes.flatMap((node, i): Array<StorageItem> => {
        const { key, type } = nodeQueries[i]!;
        if (type === "closestDescendantMerkleValue") {
          return [{ key, [type]: Binary.toHex(node.hash) }];
        }
        if (!node.value) return [];
        return [
          type === "hash"
            ? { key, hash: Binary.toHex(node.hash) }
            : { key, value: Binary.toHex(node.value) },
        ];
      })
    )
  );

  const descendantQueries = items.filter(
    (it) => it.type === "descendantsHashes" || it.type === "descendantsValues"
  );
  const descendantQueries$ = descendantQueries.map((query) =>
    from(chain.getStorageDescendants(hash, query.key)).pipe(
      map(
        (nodes): Array<StorageItem> =>
          Object.entries(nodes)
            .map(([key, node]) =>
              query.type === "descendantsHashes"
                ? {
                    key,
                    hash: Binary.toHex(node.hash),
                  }
                : node.value
                ? {
                    key,
                    value: Binary.toHex(node.value),
                  }
                : null
            )
            .filter((v) => v != null)
      )
    )
  );

  subscription.add(
    merge(nodeQueries$, ...descendantQueries$)
      .pipe(filter((v) => v.length > 0))
      .subscribe({
        next: (items) =>
          con.send(
            followEvent(followSubscription, {
              event: "operationStorageItems",
              operationId: opId,
              items,
            })
          ),
        error: (e) => {
          console.error(e);
          con.send(
            followEvent(followSubscription, {
              event: "operationError",
              operationId: opId,
              error: e.message,
            })
          );
          cleanup();
        },
        complete: () => {
          con.send(
            followEvent(followSubscription, {
              event: "operationStorageDone",
              operationId: opId,
            })
          );
          cleanup();
        },
      })
  );
};

export const chainHead_v1_call: RpcMethod = (
  con,
  req: JsonRpcRequest<{
    followSubscription: string;
    hash: HexString;
    function: HexString;
    callParameters: HexString;
  }>,
  { chain }
) => {
  const {
    followSubscription,
    hash,
    function: fnName,
    callParameters,
  } = getParams(req, [
    "followSubscription",
    "hash",
    "function",
    "callParameters",
  ]);

  const sub = con.context.chainHead_v1_subs[followSubscription];
  if (!sub) return con.send(respond(req, { result: "limitReached" }));

  if (!sub.pinnedBlocks.has(hash)) return con.send(blockNotPinned(req));

  const block = chain.getBlock(hash);
  if (!block) return con.send(blockNotReadable(req));

  const opId = getUuid();
  const subscription = new Subscription();
  sub.operations[opId] = subscription;
  const cleanup = () => {
    delete sub.operations[opId];
    subscription.unsubscribe();
  };

  con.send(
    respond(req, {
      result: "started",
      operationId: opId,
    })
  );

  subscription.add(
    from(
      runRuntimeCall({
        chain,
        hash,
        call: fnName,
        params: callParameters,
      })
    ).subscribe({
      next: (output) =>
        con.send(
          followEvent(followSubscription, {
            event: "operationCallDone",
            operationId: opId,
            output: output.result,
          })
        ),
      error: (e) => {
        console.error(e);
        con.send(
          followEvent(followSubscription, {
            event: "operationError",
            operationId: opId,
            error: e.message,
          })
        );
        cleanup();
      },
      complete: () => {
        cleanup();
      },
    })
  );
};

export const chainHead_v1_body: RpcMethod = (
  con,
  req: JsonRpcRequest<{
    followSubscription: string;
    hash: string;
  }>,
  { chain }
) => {
  const { followSubscription, hash } = getParams(req, [
    "followSubscription",
    "hash",
  ]);

  const sub = con.context.chainHead_v1_subs[followSubscription];
  if (!sub) return con.send(respond(req, { result: "limitReached" }));

  if (!sub.pinnedBlocks.has(hash)) return con.send(blockNotPinned(req));

  const block = chain.getBlock(hash);
  if (!block) return con.send(blockNotReadable(req));

  const opId = getUuid();
  con.send(
    respond(req, {
      result: "started",
      operationId: opId,
    })
  );

  con.send(
    followEvent(followSubscription, {
      event: "operationBodyDone",
      operationId: opId,
      value: block.body.map(Binary.toHex),
    })
  );
};

export const chainHead_v1_stopOperation: RpcMethod = (
  con,
  req: JsonRpcRequest<{
    followSubscription: string;
    operationId: string;
  }>,
  { chain }
) => {
  const { followSubscription, operationId } = getParams(req, [
    "followSubscription",
    "operationId",
  ]);

  con.send(respond(req, null));

  const sub = con.context.chainHead_v1_subs[followSubscription];
  if (!sub?.operations[operationId]) return;
  sub.operations[operationId].unsubscribe();
  delete sub.operations[operationId];
};

export const chainHead_v1_unpin: RpcMethod = (
  con,
  req: JsonRpcRequest<{
    followSubscription: string;
    hashOrHashes: HexString | HexString[];
  }>,
  {}
) => {
  const { followSubscription, hashOrHashes } = getParams(req, [
    "followSubscription",
    "hashOrHashes",
  ]);

  const sub = con.context.chainHead_v1_subs[followSubscription];
  if (!sub) return con.send(respond(req, null));

  const hashes = Array.isArray(hashOrHashes) ? hashOrHashes : [hashOrHashes];
  const uniqueHashes = new Set(hashes);
  if (uniqueHashes.size != hashes.length)
    return con.send(
      errorResponse(req, {
        code: -32804,
        message: "Duplicate hashes",
      })
    );
  if (hashes.some((hash) => !sub.pinnedBlocks.has(hash)))
    return con.send(blockNotPinned(req));

  hashes.forEach((hash) => sub.pinnedBlocks.delete(hash));

  return con.send(respond(req, null));
};
