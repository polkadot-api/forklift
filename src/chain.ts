import { BehaviorSubject, type Observable } from "rxjs";
import type { HexString, Source } from "./source";

export type { HexString };

export interface Block {
  hash: HexString;
  parent: HexString;
  height: number;
  code: Uint8Array;
  storageDiff: () => Promise<Record<HexString, Uint8Array | null>>;
}

export interface NewBlockOptions {
  type: "best" | "finalized";
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
  best$: Observable<HexString>;
  finalized$: Observable<HexString>;

  newBlock: (opts?: Partial<NewBlockOptions>) => void;
  changeBest: (hash: HexString) => void;
  changeFinalized: (hash: HexString) => void;
  setStorage: (
    hash: HexString,
    changes: Record<HexString, Uint8Array | null>
  ) => void;
}

interface ChainState {
  blocks: Record<HexString, Block>;
  pendingStorage: Record<HexString, Record<HexString, Uint8Array | null>>;
}

const CODE_KEY: HexString = "0x3a636f6465"; // hex-encoded ":code"

const EMPTY = {};
const lazyValue = <T>(cb: () => T | Promise<T>) => {
  let value: any = EMPTY;
  return (): Promise<T> => {
    if (value === EMPTY) value = cb();
    return Promise.resolve(value);
  };
};

export const createChain = async (
  sourceP: Source | Promise<Source>
): Promise<Chain> => {
  const source = await sourceP;

  // Fetch the runtime code from the source
  const code = await source.getStorage(CODE_KEY);
  if (!code) {
    throw new Error("No runtime code found at source block");
  }

  // Create the initial block from the source
  const initialBlock: Block = {
    hash: source.blockHash,
    parent:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    height: source.header.number,
    code,
    storageDiff: async () => ({}),
  };

  const blocks$ = new BehaviorSubject<Record<HexString, Block>>({
    [source.blockHash]: initialBlock,
  });
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
    const original = block.storageDiff;
    block.storageDiff = lazyValue(async () => ({
      ...(await original()),
      ...changes,
    }));
  };

  const newBlock = (_opts?: Partial<NewBlockOptions>): void => {
    // TODO: implement block building
    throw new Error("newBlock not yet implemented");
  };

  return {
    blocks$: blocks$.asObservable(),
    best$: best$.asObservable(),
    finalized$: finalized$.asObservable(),
    newBlock,
    changeBest,
    changeFinalized,
    setStorage,
  };
};
