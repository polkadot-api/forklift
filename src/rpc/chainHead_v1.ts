import { blockHeader } from "@polkadot-api/substrate-bindings";
import type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
} from "@polkadot-api/substrate-client";
import type { HexString } from "polkadot-api";
import { Binary } from "polkadot-api";
import {
  combineLatest,
  firstValueFrom,
  from,
  map,
  merge,
  pairwise,
  Subscription,
  withLatestFrom,
} from "rxjs";
import { getParams, getUuid, respond, type RpcMethod } from "./rpc_utils";

const followEvent = (subscription: string, result: any): JsonRpcMessage => ({
  jsonrpc: "2.0",
  method: "chainHead_v1_followEvent",
  params: {
    subscription,
    result,
  },
});
const blockNotPinned = (req: JsonRpcRequest): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id: req.id!,
  error: {
    code: -32801,
    message: "Block not pinned",
  },
});
const blockNotReadable = (req: JsonRpcRequest): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id: req.id!,
  error: {
    code: -32603,
    message: "Block not readable",
  },
});

export const chainHead_v1_follow: RpcMethod = async (
  chain,
  con,
  req: JsonRpcRequest<{
    withRuntime: boolean;
  }>
) => {
  const { withRuntime } = getParams(req, ["withRuntime"]);

  const subId = getUuid();
  const ctx = {
    pinnedBlocks: new Set<string>(),
    storageOps: {},
  };
  con.context.chainHead_v1_subs[subId] = ctx;
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
          newRuntime: childBlock.hasNewRuntime,
        })
      );
      sendChildren(child);
    }
  };
  sendChildren(finalized);

  const subscription = new Subscription();
  subscription.add(con.disconnect$.subscribe(() => subscription.unsubscribe()));

  subscription.add(
    chain.newBlocks$
      .pipe(withLatestFrom(chain.blocks$))
      .subscribe(([blockHash, blocks]) => {
        const block = blocks[blockHash]!;
        ctx.pinnedBlocks.add(blockHash);
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
  subscription.add(
    chain.best$.subscribe((bestBlockHash) => {
      con.send(
        followEvent(subId, { event: "bestBlockChanged", bestBlockHash })
      );
    })
  );
  subscription.add(
    chain.finalized$
      .pipe(pairwise(), withLatestFrom(chain.blocks$))
      .subscribe(([[prev, next], blocks]) => {
        const finalizedBlockHashes = [next];
        let blockHash = next;
        while (
          blocks[blockHash]?.parent !== prev &&
          blocks[blockHash]?.parent! in blocks
        ) {
          blockHash = blocks[blockHash]!.parent;
          finalizedBlockHashes.push(blockHash);
        }
        finalizedBlockHashes.reverse();

        const prunedBlockHashes: HexString[] = [];
        const pruneBranch = (hash: HexString) => {
          const block = blocks[hash];
          if (!block) return;
          prunedBlockHashes.push(hash);
          block.children.forEach(pruneBranch);
        };

        let i = 0;
        blockHash = prev;
        while (blockHash !== next) {
          const block = blocks[blockHash]!;
          for (const child of block.children) {
            if (child === finalizedBlockHashes[i]) continue;
            pruneBranch(child);
          }
          blockHash = finalizedBlockHashes[i]!;
          i++;
        }

        con.send(
          followEvent(subId, {
            event: "finalized",
            finalizedBlockHashes,
            prunedBlockHashes,
          })
        );
      })
  );
};

export const chainHead_v1_header: RpcMethod = (
  chain,
  con,
  req: JsonRpcRequest<{
    followSubscription: string;
    hash: string;
  }>
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
  chain,
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
  }>
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
  sub.storageOps[opId] = {
    hash,
    items,
    childTrie,
    subscription,
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
    chain.getStorageBatch(
      hash,
      nodeQueries.map((it) => it.key)
    )
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

  // TODO descendantQueries
  const descendantQueries = items.filter(
    (it) => it.type === "descendantsHashes" || it.type === "descendantsValues"
  );

  subscription.add(
    merge(nodeQueries$).subscribe({
      next: (items) =>
        con.send(
          followEvent(followSubscription, {
            event: "operationStorageItems",
            operationId: opId,
            items,
          })
        ),
      error: (e) => {
        con.send(
          followEvent(followSubscription, {
            event: "operationError",
            operationId: opId,
            error: e.message,
          })
        );
        console.error(e);
      },
      complete: () =>
        con.send(
          followEvent(followSubscription, {
            event: "operationStorageDone",
            operationId: opId,
          })
        ),
    })
  );
};
