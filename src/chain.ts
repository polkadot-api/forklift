import { file } from "bun";
import { Binary, type HexString } from "polkadot-api";
import {
  BehaviorSubject,
  filter,
  map,
  pairwise,
  Subject,
  withLatestFrom,
  type Observable,
} from "rxjs";
import {
  createBlock,
  type Block,
  type CreateBlockParams,
} from "./block-builder/create-block";
import { setBlockMeta } from "./codecs";
import { getRuntimeVersion } from "./executor";
import type { Source } from "./source";
import {
  createRoot,
  deleteValue,
  forEachDescendant,
  getDescendantNodes,
  getDiff,
  getNode,
  getSoftDeletedDescendantKeys,
  insertValue,
  type StorageNode,
} from "./storage";

export interface Chain {
  blocks$: Observable<Record<HexString, Block>>;
  newBlocks$: Observable<HexString>;
  best$: Observable<HexString>;
  finalized$: Observable<HexString>;

  getBlock: (hash: HexString) => Block | undefined;

  newBlock: (
    type: "best" | "finalized" | "fork",
    params: CreateBlockParams
  ) => Promise<Block>;
  changeBest: (hash: HexString) => void;
  changeFinalized: (hash: HexString) => void;
  setStorage: (
    hash: HexString,
    changes: Record<HexString, Uint8Array | null>
  ) => void;

  getStorage: (hash: HexString, key: HexString) => Promise<StorageNode>;
  getStorageBatch: (
    hash: HexString,
    keys: HexString[]
  ) => Promise<StorageNode[]>;
  getStorageDescendants: (
    hash: HexString,
    prefix: HexString
  ) => Promise<Record<HexString, StorageNode>>;

  // prev: undefined means unknown: the storage value wasn't loaded. So it was set, but we don't know the value we had previously
  // prev: null means the value was empty.
  getStorageDiff: (
    hash: HexString,
    baseHash?: HexString
  ) => Promise<
    Record<string, { value: Uint8Array | null; prev?: Uint8Array | null }>
  >;

  hrmpChannels: Set<number>;
  openHrmpChannel: (recipientParaId: number) => void;
}

const CODE_KEY: HexString = "0x3a636f6465"; // hex-encoded ":code"

export const createChain = (source: Source, key?: string): Chain => {
  const cacheFile = key ? `code_${key}.bin` : null;

  const blocks$ = new BehaviorSubject<Record<HexString, Block>>({});
  const newBlocks$ = new Subject<HexString>();
  const bestSrc$ = new BehaviorSubject<HexString | null>(null);
  const best$ = bestSrc$.pipe(filter((v) => v != null));
  const finalizedSrc$ = new BehaviorSubject<HexString | null>(null);
  const finalized$ = finalizedSrc$.pipe(filter((v) => v != null));

  // Create the initial block from the source
  const asyncInitialBlock: Promise<Block> = source.block.then(async (block) => {
    console.log("Loading code");
    const code =
      cacheFile && (await file(cacheFile).exists())
        ? await file(cacheFile).bytes()
        : await source.getStorage(CODE_KEY);

    if (!code) {
      throw new Error("No runtime code found at source block");
    }
    if (cacheFile) file(cacheFile).write(code);

    console.log("Code loaded, getting runtime");
    const initialRuntime = await getRuntimeVersion(code);
    console.log("Runtime loaded");

    const result: Block = {
      hash: block.blockHash,
      parent:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      height: block.header.number,
      header: block.header,
      body: block.body,
      code,
      storageRoot: insertValue(
        createRoot(),
        Binary.fromHex(CODE_KEY),
        CODE_KEY.length - 2,
        code
      ),
      runtime: initialRuntime,
      children: [],
    };

    blocks$.next({
      [result.hash]: result,
    });
    setBlockMeta(chain, result);

    bestSrc$.next(result.hash);
    finalizedSrc$.next(result.hash);

    return result;
  });

  const getBlock = (hash: HexString) => blocks$.getValue()[hash]!;
  const assertBlock = (hash: HexString) => {
    const block = getBlock(hash);
    if (!block) {
      throw new Error(`Block not found`);
    }
    return block;
  };

  const isDescendant = (parentHash: HexString, descendantHash: HexString) => {
    const parent = getBlock(parentHash);
    let block = getBlock(descendantHash);
    while (block.height > parent.height) {
      block = getBlock(block.parent);
    }
    return block.hash === parent.hash;
  };
  const assertFinalizedDescendant = (hash: HexString) => {
    if (!isDescendant(finalizedSrc$.getValue()!, hash)) {
      throw new Error(`Block is not a descendant of finalized`);
    }
  };

  const changeBest = (hash: HexString) => {
    assertBlock(hash);
    assertFinalizedDescendant(hash);

    bestSrc$.next(hash);
  };

  const changeFinalized = (hash: HexString) => {
    assertBlock(hash);
    assertFinalizedDescendant(hash);

    if (!isDescendant(hash, bestSrc$.getValue()!)) {
      bestSrc$.next(hash);
    }
    finalizedSrc$.next(hash);
  };

  const setStorage = (
    hash: HexString,
    changes: Record<HexString, Uint8Array | null>
  ): void => {
    const block = assertBlock(hash);
    for (const key in changes) {
      const binKey = Binary.fromHex(key);
      if (changes[key]) {
        block.storageRoot = insertValue(
          block.storageRoot,
          binKey,
          binKey.length * 2,
          changes[key]
        );
      } else {
        block.storageRoot = deleteValue(
          block.storageRoot,
          binKey,
          binKey.length * 2
        );
      }
    }
  };

  const getStorage = async (
    hash: HexString,
    key: HexString
  ): Promise<StorageNode> => {
    const initialBlock = await asyncInitialBlock;

    const block = assertBlock(hash);
    const binKey = Binary.fromHex(key);
    const node =
      getNode(block.storageRoot, binKey, binKey.length * 2) ??
      // The initialBlock's storage might mutate as data is loaded from source
      // and because of the immutable storage structure, newer blocks won't see that state.
      getNode(initialBlock.storageRoot, binKey, binKey.length * 2);

    if (node?.value !== undefined) {
      return node;
    }

    const sourceResult = await source.getStorage(key);
    initialBlock.storageRoot = insertValue(
      initialBlock.storageRoot,
      binKey,
      binKey.length * 2,
      sourceResult
    );
    return getNode(initialBlock.storageRoot, binKey, binKey.length * 2)!;
  };

  const getStorageBatch = async (
    hash: HexString,
    keys: HexString[]
  ): Promise<StorageNode[]> => {
    const initialBlock = await asyncInitialBlock;
    const block = assertBlock(hash);

    const keysIndexed = keys.map((key, idx) => ({ key, idx }));
    const pending = new Array<{
      binKey: Uint8Array;
      key: HexString;
      idx: number;
    }>();

    const result = keysIndexed.map(({ key, idx }) => {
      const binKey = Binary.fromHex(key);
      const node =
        getNode(block.storageRoot, binKey, binKey.length * 2) ??
        // The initialBlock's storage might mutate as data is loaded from source
        // and because of the immutable storage structure, newer blocks won't see that state.
        getNode(initialBlock.storageRoot, binKey, binKey.length * 2);

      if (node?.value !== undefined) {
        return node;
      }
      pending.push({ key, idx, binKey });
      return null!;
    });

    const loadedResults = await source.getStorageBatch(
      pending.map(({ key }) => key)
    );
    loadedResults.forEach((res, i) => {
      const { idx, binKey } = pending[i]!;
      initialBlock.storageRoot = insertValue(
        initialBlock.storageRoot,
        binKey,
        binKey.length * 2,
        res
      );
      result[idx] = getNode(
        initialBlock.storageRoot,
        binKey,
        binKey.length * 2
      )!;
    });

    return result;
  };

  const getStorageDescendants = async (
    hash: HexString,
    prefix: HexString
  ): Promise<Record<HexString, StorageNode>> => {
    const initialBlock = await asyncInitialBlock;
    const block = assertBlock(hash);
    const binPrefix = Binary.fromHex(prefix);

    const getNodeDescendants = (node: StorageNode | null) =>
      node
        ? Object.fromEntries(
            getDescendantNodes(node, binPrefix, binPrefix.length * 2).map(
              ({ key, node }) => [Binary.toHex(key), node]
            )
          )
        : {};

    const blockNode = getNode(
      block.storageRoot,
      binPrefix,
      binPrefix.length * 2
    );
    if (blockNode?.exhaustive) {
      return getNodeDescendants(blockNode);
    }

    let rootNode = getNode(
      initialBlock.storageRoot,
      binPrefix,
      binPrefix.length * 2
    );
    if (!rootNode?.exhaustive) {
      const sourceDescendants = await source.getStorageDescendants(prefix);
      if (!Object.keys(sourceDescendants).length)
        initialBlock.storageRoot = insertValue(
          initialBlock.storageRoot,
          binPrefix,
          binPrefix.length * 2,
          null
        );
      for (const key in sourceDescendants) {
        const binKey = Binary.fromHex(key);
        initialBlock.storageRoot = insertValue(
          initialBlock.storageRoot,
          binKey,
          binKey.length * 2,
          sourceDescendants[key]!
        );
      }
      // mark node as exhaustive
      rootNode = getNode(
        initialBlock.storageRoot,
        binPrefix,
        binPrefix.length * 2
      )!;
      rootNode.exhaustive = true;
      forEachDescendant(rootNode, (node) => (node.exhaustive = true));
    }

    // There's a temptation to propagate this exhaustive to the blockNode
    // but then it could mess up storage diffs.

    // Soft-deleted keys in blockNode must explicitly exclude entries from rootNode.
    // getDescendantNodes skips null-valued nodes, so without this the old rootNode
    // value would leak through for deleted keys.
    const deletedKeys = blockNode
      ? new Set(
          getSoftDeletedDescendantKeys(
            blockNode,
            binPrefix,
            binPrefix.length * 2
          ).map(Binary.toHex)
        )
      : null;

    const rootDescendants = getNodeDescendants(rootNode);
    return {
      ...(deletedKeys
        ? Object.fromEntries(
            Object.entries(rootDescendants).filter(
              ([key]) => !deletedKeys.has(key)
            )
          )
        : rootDescendants),
      ...getNodeDescendants(blockNode),
    };
  };

  const getStorageDiff = async (hash: HexString, baseHash?: HexString) => {
    const target = getBlock(hash);
    if (!target) {
      throw new Error(`Block not found`);
    }

    const base = getBlock(baseHash ?? target.parent);
    if (!base) {
      throw new Error(`Parent block not loaded`);
    }
    const diff = getDiff(
      base.storageRoot,
      (await asyncInitialBlock).storageRoot,
      target.storageRoot
    );
    const prevs = Object.fromEntries(
      getDescendantNodes(diff.prev, new Uint8Array(), 0).map(
        ({ key, node }) => [Binary.toHex(key), node.value]
      )
    );

    const inserts = getDescendantNodes(diff.insert, new Uint8Array(), 0).map(
      ({ key, node }) => [Binary.toHex(key), node.value!] as const
    );
    const deletes = diff.deleteValues.map(
      ({ key }) => [Binary.toHex(key), null] as const
    );

    return Object.fromEntries(
      [...inserts, ...deletes].map(([key, value]) => [
        key,
        { value, prev: prevs[key] },
      ])
    );
  };

  const newBlock: Chain["newBlock"] = async (type, params): Promise<Block> => {
    assertBlock(params.parent);
    assertFinalizedDescendant(params.parent);

    const block = await createBlock(chain, params);

    // If the finalized has changed while we were building the block and this one
    // became pruned, then we should fail.
    assertFinalizedDescendant(params.parent);

    // Add block to blocks$
    blocks$.next({
      ...blocks$.getValue(),
      [block.hash]: block,
    });

    setBlockMeta(chain, block);

    // Emit newBlocks$ event
    newBlocks$.next(block.hash);

    // Update best/finalized based on type
    if (type === "best") {
      bestSrc$.next(block.hash);
    } else if (type === "finalized") {
      bestSrc$.next(block.hash);
      finalizedSrc$.next(block.hash);
    }

    return block;
  };

  const hrmpEgressChannels = new Set<number>();

  const chain: Chain = {
    blocks$: blocks$.asObservable(),
    newBlocks$: newBlocks$.asObservable(),
    best$: best$,
    finalized$: finalized$,
    getBlock,
    newBlock,
    changeBest,
    changeFinalized,
    setStorage,
    getStorage,
    getStorageBatch,
    getStorageDescendants,
    getStorageDiff,
    hrmpChannels: hrmpEgressChannels,
    openHrmpChannel: (recipientParaId) =>
      hrmpEgressChannels.add(recipientParaId),
  };

  return chain;
};

export const finalizedAndPruned$ = (chain: Chain) =>
  chain.finalized$.pipe(
    pairwise(),
    withLatestFrom(chain.blocks$),
    map(([[prev, next], blocks]) => {
      const finalized = [next];
      let blockHash = next;
      while (
        blocks[blockHash]?.parent !== prev &&
        blocks[blockHash]?.parent! in blocks
      ) {
        blockHash = blocks[blockHash]!.parent;
        finalized.push(blockHash);
      }
      finalized.reverse();

      const pruned: HexString[] = [];
      const pruneBranch = (hash: HexString) => {
        const block = blocks[hash];
        if (!block) return;
        pruned.push(hash);
        block.children.forEach(pruneBranch);
      };

      let i = 0;
      blockHash = prev;
      while (blockHash !== next) {
        const block = blocks[blockHash]!;
        for (const child of block.children) {
          if (child === finalized[i]) continue;
          pruneBranch(child);
        }
        blockHash = finalized[i]!;
        i++;
      }

      return {
        finalized,
        pruned,
      };
    })
  );
