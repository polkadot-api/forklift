import { type JsonRpcProvider } from "@polkadot-api/substrate-client";
import { Binary, Enum, type HexString } from "polkadot-api";
import { Blake2256, Bytes, Struct, u32 } from "@polkadot-api/substrate-bindings";
import { combineLatest, firstValueFrom, map } from "rxjs";
import { createChain, type Chain, type NewBlockOptions } from "./chain";
import { runPrequeries } from "./prequeries";
import { createServer } from "./serve";
import { createRemoteSource } from "./source";
import { createTxPool } from "./txPool";
import type { XcmMessages } from "./block-builder/create-block";
import { getConstant, getExtrinsicDecoder, getStorageCodecs } from "./codecs";

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
  getXcm(): Promise<{
    dmp: Record<
      number,
      Array<{
        sent_at: number;
        msg: Uint8Array;
      }>
    >;
  }>;
  getProcessedDmp(
    hash?: HexString
  ): Promise<{ paraId: number; messages: XcmMessages["dmp"] } | null>;
  applyProcessedDmp(
    paraId: number,
    messages: XcmMessages["dmp"],
    hash?: HexString
  ): Promise<void>;
  applyProcessedDmpFrom(
    parachain: Forklift,
    opts?: { paraHash?: HexString; relayHash?: HexString }
  ): Promise<void>;

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
  disableOnIdle?: boolean;
  mockSignatureHost?: (signature: Uint8Array) => boolean;
  xcmProvider?: () => Promise<XcmMessages>;
  key?: string;
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
  const chain = createChain(source, opts?.key);
  const txPool = createTxPool(chain);

  runPrequeries(chain);

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
      const xcm = opts?.xcm
        ? Promise.resolve(opts.xcm)
        : options.xcmProvider?.();

      const type =
        opts?.type ||
        (options.finalizeMode.type === "timer" &&
        options.finalizeMode.value === 0
          ? "finalized"
          : undefined);
      const parent = opts?.parent ?? (await firstValueFrom(chain.best$));
      const parentBlock = chain.getBlock(parent)!;

      const transactions =
        opts?.transactions ?? (await txPool.getTxsForBlock(parentBlock));
      // An automatic trigger from tx pool should not produce the block if the block won't have any tx
      if (automatic && transactions.length === 0) {
        console.log(
          "Skipped building automatic block: none of the transactions are ready"
        );
        return parent;
      }
      const block = await chain.newBlock({
        ...opts,
        type,
        parent,
        transactions,
        disableOnIdle: opts?.disableOnIdle ?? options.disableOnIdle,
        xcm: await xcm,
      });

      if (type == null) {
        // best changes immediately if it became higher
        const [best, blocks] = await firstValueFrom(
          combineLatest([chain.best$, chain.blocks$])
        );
        if (block.height > blocks[best]!.height) {
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

  const getProcessedDmp = async (hash?: HexString) => {
    const target = hash ?? (await firstValueFrom(chain.best$));
    const block = chain.getBlock(target);
    if (!block) return null;

    const txDec = await getExtrinsicDecoder(block);
    const validationExtRaw = block.body.find((raw) => {
      const ext = txDec(raw);
      return (
        ext.call.type === "ParachainSystem" &&
        ext.call.value.type === "set_validation_data"
      );
    });
    if (!validationExtRaw) return null;

    const validationExt = txDec(validationExtRaw);
    const callValue = validationExt.call.value.value;
    const messages =
      callValue?.inbound_messages_data?.downward_messages?.full_messages ??
      callValue?.inboundMessagesData?.downwardMessages?.fullMessages ??
      [];
    if (!Array.isArray(messages)) return null;

    const paraId = await getConstant(block, "ParachainSystem", "SelfParaId");
    if (paraId == null) return null;

    return {
      paraId: Number(paraId),
      messages,
    };
  };

  const applyProcessedDmp = async (
    paraId: number,
    messages: XcmMessages["dmp"],
    hash?: HexString
  ) => {
    if (!messages.length) return;
    const target = hash ?? (await firstValueFrom(chain.best$));
    const block = chain.getBlock(target);
    if (!block) return;

    const queueCodec = await getStorageCodecs(
      block,
      "Dmp",
      "DownwardMessageQueues"
    );
    const headsCodec = await getStorageCodecs(
      block,
      "Dmp",
      "DownwardMessageQueueHeads"
    );
    if (!queueCodec || !headsCodec) return;

    const queueKey = queueCodec.keys.enc(paraId);
    const headsKey = headsCodec.keys.enc(paraId);
    const [queueNode, headsNode] = await chain.getStorageBatch(block.hash, [
      queueKey,
      headsKey,
    ]);

    const queueDecoded = queueNode?.value
      ? queueCodec.value.dec(queueNode.value)
      : [];
    if (!Array.isArray(queueDecoded)) {
      throw new Error("Unexpected DMP queue shape");
    }

    if (queueDecoded.length < messages.length) {
      throw new Error("DMP queue shorter than processed messages");
    }

    for (let i = 0; i < messages.length; i++) {
      const queued = queueDecoded[i] as XcmMessages["dmp"][number];
      const processed = messages[i]!;
      if (!dmpMessagesEqual(queued, processed)) {
        throw new Error("Processed DMP messages do not match relay queue");
      }
    }

    const remaining = queueDecoded.slice(messages.length);
    const prevHead = headsNode?.value
      ? headsCodec.value.dec(headsNode.value)
      : null;
    const prevHeadBytes = toHeadBytes(prevHead);

    let nextHead = prevHeadBytes;
    for (const message of messages) {
      nextHead = Blake2256(
        dmpChain.enc({
          hash: nextHead,
          sent_at: Number(message.sent_at),
          msg_hash: Blake2256(Binary.toOpaque(toMsgBytes(message.msg))),
        })
      );
    }

    const nextHeadValue =
      typeof prevHead === "string" ? Binary.toHex(nextHead) : nextHead;

    chain.setStorage(target, {
      [queueKey]: queueCodec.value.enc(remaining),
      [headsKey]: headsCodec.value.enc(nextHeadValue as any),
    });
  };

  const applyProcessedDmpFrom = async (
    parachain: Forklift,
    opts?: { paraHash?: HexString; relayHash?: HexString }
  ) => {
    const receipt = await parachain.getProcessedDmp(opts?.paraHash);
    if (!receipt || !receipt.messages.length) return;
    await applyProcessedDmp(
      receipt.paraId,
      receipt.messages,
      opts?.relayHash
    );
  };

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
    getProcessedDmp,
    getXcm: async () => {
      // TODO verify xcm messages are only from finalized block.
      const finalized = await firstValueFrom(
        chain.finalized$.pipe(map((f) => chain.getBlock(f)!))
      );
      const dmpCodec = await getStorageCodecs(
        finalized,
        "Dmp",
        "DownwardMessageQueues"
      );

      const getDmp = async () => {
        if (!dmpCodec) return {};

        const entries = await chain.getStorageDescendants(
          finalized.hash,
          dmpCodec.keys.enc()
        );

        const tmp = Object.entries(entries)
          .map(([key, value]) =>
            value.value
              ? [dmpCodec.keys.dec(key)[0], dmpCodec.value.dec(value.value)]
              : null
          )
          .filter((v) => v != null);

        return Object.fromEntries(tmp);
      };

      // TODO verify xcm messages are cleared out from the queue once read.

      return {
        dmp: await getDmp(),
      };
    },
    applyProcessedDmp,
    applyProcessedDmpFrom,
  };
}

const ZERO_HEAD = new Uint8Array(32);

const dmpChain = Struct({
  hash: Bytes(32),
  sent_at: u32,
  msg_hash: Bytes(32),
});

const toHeadBytes = (value: unknown): Uint8Array => {
  if (typeof value === "string") return Binary.fromHex(value);
  if (value instanceof Uint8Array) return value;
  return ZERO_HEAD;
};

const toMsgBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return Binary.fromHex(value);
  return new Uint8Array();
};

const dmpMessagesEqual = (
  queued: XcmMessages["dmp"][number],
  processed: XcmMessages["dmp"][number]
) => {
  if (Number(queued.sent_at) !== Number(processed.sent_at)) return false;
  return bytesEqual(toMsgBytes(queued.msg), toMsgBytes(processed.msg));
};

const bytesEqual = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};
