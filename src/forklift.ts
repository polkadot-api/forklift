import { type JsonRpcProvider } from "@polkadot-api/substrate-client";
import { Enum, type HexString } from "polkadot-api";
import { combineLatest, firstValueFrom } from "rxjs";
import { createChain, type NewBlockOptions } from "./chain";
import { createServer } from "./serve";
import { createRemoteSource } from "./source";
import { createTxPool } from "./txPool";

export interface Forklift {
  serve: JsonRpcProvider;

  newBlock: (opts?: Partial<NewBlockOptions>) => Promise<HexString>;
  changeBest: (hash: HexString) => Promise<void>;
  changeFinalized: (hash: HexString) => Promise<void>;
  setStorage: (
    hash: HexString,
    changes: Record<string, Uint8Array>
  ) => Promise<void>;
  getStorageDiff: (
    hash: HexString,
    baseHash?: HexString
  ) => Promise<
    Record<string, { value: Uint8Array | null; prev?: Uint8Array | null }>
  >;

  changeOptions: (options: Partial<ForkliftOptions>) => void;
  destroy: () => void;
}

export type ForkliftSource = Enum<{
  remote: {
    url: string | string[];
    atBlock?: number | string;
  };
  // genesis: Record<string, string>;
}>;

export type DelayMode = Enum<{
  manual: undefined;
  timer: number;
}>;

export interface ForkliftOptions {
  buildBlockMode: DelayMode;
  finalizeMode: DelayMode;
  mockSignatureHost?: (signature: Uint8Array) => boolean;
}

const defaultOptions: ForkliftOptions = {
  buildBlockMode: Enum("timer", 100),
  finalizeMode: Enum("timer", 2000),
};

type Timeout = ReturnType<typeof setTimeout>;
export function forklift(
  sourceDef: ForkliftSource,
  opts?: Partial<ForkliftOptions>
): Forklift {
  const source = createRemoteSource(sourceDef.value.url, {
    atBlock: sourceDef.value.atBlock,
  });
  let options = { ...defaultOptions, ...opts };
  const chain = createChain(source);
  const txPool = createTxPool(chain);

  let buildBlockQueue: Promise<void> | null = null;
  let blocksEnqueued = 0;
  const finalizeTimers = new Set<Timeout>();
  const newBlock = async (
    opts?: Partial<NewBlockOptions>,
    automatic?: boolean
  ) => {
    if (buildBlockQueue) {
      blocksEnqueued++;
      while (buildBlockQueue) {
        await buildBlockQueue;
      }
      blocksEnqueued--;
    }

    let resolve: () => void = () => {};
    buildBlockQueue = new Promise<void>(async (res) => (resolve = res));

    try {
      const c = await chain;
      const type =
        opts?.type ||
        (options.finalizeMode.type === "timer" &&
        options.finalizeMode.value === 0
          ? "finalized"
          : undefined);
      const parent = opts?.parent ?? (await firstValueFrom(c.best$));
      const parentBlock = c.getBlock(parent)!;

      const transactions =
        opts?.transactions ?? (await txPool.getTxsForBlock(parentBlock));
      // An automatic trigger from tx pool should not produce the block if the block won't have any tx
      if (automatic && transactions.length === 0) {
        console.log(
          "Skipped building automatic block: none of the transactions are ready"
        );
        return parent;
      }
      const block = await c.newBlock({ ...opts, type, parent, transactions });

      if (type == null) {
        // best changes immediately if it became higher
        const [best, blocks] = await firstValueFrom(
          combineLatest([c.best$, c.blocks$])
        );
        if (block.height > blocks[best]!.height) {
          c.changeBest(block.hash);
        }

        if (options.finalizeMode.type === "timer") {
          const timer = setTimeout(() => {
            try {
              c.changeFinalized(block.hash);
              // in cases of competing forks it can fail
            } catch {}
            finalizeTimers.delete(timer);
          }, options.finalizeMode.value);
          finalizeTimers.add(timer);
        }
      }

      return block.hash;
    } finally {
      buildBlockQueue = null;
      resolve();
    }
  };

  let txBlockPending = false;
  const txPoolSub = txPool.txAdded$.subscribe(() => {
    if (options.buildBlockMode.type === "manual") return;
    if (txBlockPending || blocksEnqueued) {
      // Another tx has triggered a new block, this will get included
      return;
    }

    const delay = options.buildBlockMode.value;
    if (delay === 0) {
      return newBlock(undefined, true);
    }
    txBlockPending = true;
    setTimeout(() => {
      txBlockPending = false;
      if (!blocksEnqueued) newBlock(undefined, true);
    }, delay);
  });

  return {
    serve: createServer({ source, chain, txPool, newBlock }),
    newBlock: (opts) => newBlock(opts),
    changeBest: async (hash) => chain.changeBest(hash),
    changeFinalized: async (hash) => {
      finalizeTimers.forEach(clearTimeout);
      finalizeTimers.clear();
      return chain.changeFinalized(hash);
    },
    setStorage: async (hash, changes) => chain.setStorage(hash, changes),
    getStorageDiff: (hash, baseHash) => chain.getStorageDiff(hash, baseHash),
    changeOptions(opts) {
      // TODO I think assumptions can be broken by passing { someOption: undefined }
      options = { ...options, ...opts };
    },
    destroy() {
      txPoolSub.unsubscribe();
      txPool.destroy();
      source.destroy();
    },
  };
}
