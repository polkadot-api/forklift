import { type JsonRpcProvider } from "@polkadot-api/substrate-client";
import { Enum, type HexString } from "polkadot-api";
import { combineLatest, firstValueFrom, merge, Subject } from "rxjs";
import type {
  CreateBlockParams,
  DmpMessage,
} from "./block-builder/create-block";
import { createChain } from "./chain";
import { logger } from "./logger";
import { runPrequeries } from "./prequeries";
import type { RpcMethod, ServerContext } from "./rpc/rpc_utils";
import { createServer } from "./serve";
import type { Source } from "./source";
import { createTxPool } from "./txPool";
import { pushUmp } from "./xcm";

const log = logger.child({ module: "forklift" });

export interface NewBlockOptions {
  type: "best" | "finalized" | "fork";
  unsafeBlockHeight?: number;
  parent: HexString;
  disableOnIdle: boolean;
  storage: CreateBlockParams["storage"];
  mockSignatureHost?: boolean;
}

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

export type DelayMode = Enum<{
  manual: undefined;
  timer: number;
}>;

export interface ForkliftOptions {
  buildBlockMode: DelayMode;
  finalizeMode: DelayMode;
  disableOnIdle?: boolean;
  mockSignatureHost?: boolean;
  rpcOverrides: Record<string, RpcMethod | null>;
}

const defaultOptions: ForkliftOptions = {
  buildBlockMode: Enum("timer", 100),
  finalizeMode: Enum("timer", 2000),
  rpcOverrides: {},
};

type Timeout = ReturnType<typeof setTimeout>;
export function forklift(
  source: Source,
  opts?: Partial<ForkliftOptions>
): Forklift {
  let options = { ...defaultOptions, ...removeUndefinedProperties(opts) };
  const chain = createChain(source);
  const txPool = createTxPool(chain);

  runPrequeries(chain);

  const dmpSubject = new Subject<Array<DmpMessage>>();
  let dmpMsgQueue: DmpMessage[] = [];
  const dmpSub = dmpSubject.subscribe((messages) => {
    dmpMsgQueue = [...dmpMsgQueue, ...messages];
  });

  const umpSubject = new Subject<{ paraId: number; messages: Uint8Array[] }>();
  let umpMsgQueues: Record<number, Uint8Array[]> = {};
  const umpSub = umpSubject.subscribe((msg) => {
    umpMsgQueues = {
      ...umpMsgQueues,
      [msg.paraId]: [...(umpMsgQueues[msg.paraId] ?? []), ...msg.messages],
    };
  });

  const hrmpSubject = new Subject<{
    paraId: number;
    messages: Uint8Array[];
  }>();
  let hrmpMsgQueues: Record<number, Uint8Array[]> = {};
  const hrmpSub = hrmpSubject.subscribe(({ paraId, messages }) => {
    hrmpMsgQueues = {
      ...hrmpMsgQueues,
      [paraId]: [...(hrmpMsgQueues[paraId] ?? []), ...messages],
    };
  });

  let buildBlockQueue: Promise<void> | null = null;
  let blocksEnqueued = 0;
  const finalizeTimers = new Set<Timeout>();
  const newBlock = async (
    opts?: Partial<Omit<NewBlockOptions, "xcm">>,
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

    const dmp = dmpMsgQueue;
    dmpMsgQueue = [];

    const ump = umpMsgQueues;
    umpMsgQueues = {};
    for (const paraId in ump) {
      // This sets the storage of all live blocks, as technically any block being
      // produced past finalized should have these messages
      await pushUmp(chain, Number(paraId), ump[paraId]!);
    }

    const hrmp = hrmpMsgQueues;
    hrmpMsgQueues = {};

    try {
      const type =
        opts?.unsafeBlockHeight != null
          ? "finalized"
          : opts?.type ||
            (options.finalizeMode.type === "timer" &&
            options.finalizeMode.value === 0
              ? "finalized"
              : undefined);
      const parent = opts?.parent ?? (await firstValueFrom(chain.best$));
      const parentBlock = chain.getBlock(parent)!;

      const transactions = await txPool.getTxsForBlock(parentBlock);
      // An automatic trigger from tx pool should not produce the block if the block won't have any tx
      if (
        automatic &&
        transactions.length +
          dmp.length +
          Object.keys(ump).length +
          Object.keys(hrmp).length ===
          0
      ) {
        log.debug("skipped automatic block: no transactions ready");
        return parent;
      }

      logger.info("creating block");
      const block = await chain.newBlock(type ?? "fork", {
        parent,
        transactions,
        disableOnIdle: opts?.disableOnIdle ?? options.disableOnIdle ?? false,
        xcm: { dmp, hrmp },
        storage: opts?.storage ?? {},
        unsafeBlockHeight: opts?.unsafeBlockHeight,
        mockSignatureHost:
          opts?.mockSignatureHost ?? options.mockSignatureHost ?? false,
      });
      logger.info(`block ${block.hash} created`);

      if (type == null) {
        // best changes immediately if it became higher
        const [best, blocks] = await firstValueFrom(
          combineLatest([chain.best$, chain.blocks$])
        );
        if (block.header.number > blocks[best]!.header.number) {
          chain.changeBest(block.hash);
        }

        if (options.finalizeMode.type === "timer") {
          const timer = setTimeout(() => {
            try {
              chain.changeFinalized(block.hash);
              // in cases of competing forks it can fail
            } catch {}
            finalizeTimers.delete(timer);
          }, options.finalizeMode.value);
          finalizeTimers.add(timer);
        }
      }

      return block.hash;
    } catch (ex) {
      logger.error(ex, "failed creating block");

      // Restore messages that were dequeued but couldn't be processed
      dmpMsgQueue = [...dmp, ...dmpMsgQueue];
      for (const senderId in hrmp) {
        hrmpMsgQueues[senderId] = [
          ...(hrmp[senderId] ?? []),
          ...(hrmpMsgQueues[senderId] ?? []),
        ];
      }
      throw ex;
    } finally {
      buildBlockQueue = null;
      resolve();
    }
  };

  let txBlockPending = false;
  const txPoolSub = merge(
    txPool.txAdded$,
    dmpSubject,
    umpSubject,
    hrmpSubject
  ).subscribe(() => {
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

  const xcm: ServerContext["xcm"] = {
    pushDmp: (messages) => dmpSubject.next(messages),
    pushUmp: (paraId, messages) => umpSubject.next({ paraId, messages }),
    pushHrmp: (paraId, messages) => hrmpSubject.next({ paraId, messages }),
  };

  const serve = createServer(
    { source, chain, txPool, newBlock, xcm },
    options.rpcOverrides
  );

  return {
    serve,
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
      options = { ...options, ...removeUndefinedProperties(opts) };
      serve.setRpcOverrides(options.rpcOverrides);
    },
    destroy() {
      dmpSub.unsubscribe();
      umpSub.unsubscribe();
      hrmpSub.unsubscribe();
      txPoolSub.unsubscribe();
      txPool.destroy();
      source.destroy();
    },
  };
}

const removeUndefinedProperties = <T extends object>(value: T | undefined) =>
  value &&
  Object.fromEntries(
    Object.entries(value).filter(([, value]) => value !== undefined)
  );
