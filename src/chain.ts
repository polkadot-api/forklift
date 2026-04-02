import { Binary, type BlockHeader, type HexString } from "polkadot-api";
import { BehaviorSubject, Subject, type Observable } from "rxjs";
import { getRuntimeVersion, type RuntimeVersion } from "./executor";
import type { Source } from "./source";
import {
  createRoot,
  deleteValue,
  forEachDescendant,
  getDescendantNodes,
  getNode,
  insertValue,
  type StorageNode,
} from "./storage";

export interface Block {
  hash: HexString;
  parent: HexString;
  height: number;
  code: Uint8Array;
  storageRoot: StorageNode;
  header: BlockHeader;
  runtime: RuntimeVersion;
  hasNewRuntime?: boolean;
  children: HexString[];
}

export interface NewBlockOptions {
  type: "best" | "finalized" | "fork";
  parent: HexString;
  unsafeBlockHeight: number;
  transactions: Uint8Array[];
  dmp: Uint8Array[];
  hrmp: Record<number, Uint8Array[]>;
  ump: Record<number, Uint8Array[]>;
  storage: Record<HexString, Uint8Array | null>;
}

export interface Chain {
  blocks$: Observable<Record<HexString, Block>>;
  newBlocks$: Observable<HexString>;
  best$: Observable<HexString>;
  finalized$: Observable<HexString>;

  getBlock: (hash: HexString) => Block | undefined;

  newBlock: (opts?: Partial<NewBlockOptions>) => void;
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
}

const CODE_KEY: HexString = "0x3a636f6465"; // hex-encoded ":code"

// const EMPTY = {};
// const lazyValue = <T>(cb: () => T | Promise<T>) => {
//   let value: any = EMPTY;
//   return (): Promise<T> => {
//     if (value === EMPTY) value = cb();
//     return Promise.resolve(value);
//   };
// };

export const createChain = async (
  sourceP: Source | Promise<Source>
): Promise<Chain> => {
  const source = await sourceP;

  // Fetch the runtime code from the source
  console.log("Loading code");
  const code = await source.getStorage(CODE_KEY);
  if (!code) {
    throw new Error("No runtime code found at source block");
  }
  console.log("Code loaded, getting runtime");
  const initialRuntime = await getRuntimeVersion(code);
  console.log("Runtime loaded");

  const storageRoot = insertValue(
    createRoot(),
    Binary.fromHex(CODE_KEY),
    CODE_KEY.length - 2,
    code
  );

  // Create the initial block from the source
  const initialBlock: Block = {
    hash: source.blockHash,
    parent:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    height: source.header.number,
    header: source.header,
    code,
    storageRoot,
    runtime: initialRuntime,
    children: [],
  };

  const blocks$ = new BehaviorSubject<Record<HexString, Block>>({
    [source.blockHash]: initialBlock,
  });
  const newBlocks$ = new Subject<HexString>();
  const best$ = new BehaviorSubject<HexString>(source.blockHash);
  const finalized$ = new BehaviorSubject<HexString>(source.blockHash);

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
    if (!isDescendant(finalized$.getValue(), hash)) {
      throw new Error(`Block is not a descendant of finalized`);
    }
  };

  const changeBest = (hash: HexString) => {
    assertBlock(hash);
    assertFinalizedDescendant(hash);

    best$.next(hash);
  };

  const changeFinalized = (hash: HexString) => {
    assertBlock(hash);
    assertFinalizedDescendant(hash);

    if (!isDescendant(hash, best$.getValue())) {
      best$.next(hash);
    }
    finalized$.next(hash);
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
      if (!sourceDescendants.length)
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

    return {
      ...getNodeDescendants(rootNode),
      ...getNodeDescendants(blockNode),
    };
  };

  const newBlock = (_opts?: Partial<NewBlockOptions>): void => {
    // TODO: implement block building
    throw new Error("newBlock not yet implemented");
  };

  return {
    blocks$: blocks$.asObservable(),
    newBlocks$: newBlocks$.asObservable(),
    best$: best$.asObservable(),
    finalized$: finalized$.asObservable(),
    getBlock,
    newBlock,
    changeBest,
    changeFinalized,
    setStorage,
    getStorage,
    getStorageBatch,
    getStorageDescendants,
  };
};
