import { Binary, Enum, type HexString, type ResultPayload } from "polkadot-api";
import {
  combineLatest,
  firstValueFrom,
  from,
  Observable,
  Subject,
  Subscription,
  switchMap,
  withLatestFrom,
} from "rxjs";
import type { Block } from "./block-builder/create-block";
import { logger } from "./logger";

const log = logger.child({ module: "txPool" });
import { finalizedAndPruned$, type Chain } from "./chain";
import { getCallCodec } from "./codecs";
import { runRuntimeCall } from "./executor";

type Validation = {
  provides: Set<HexString>;
  requires: Set<HexString>;
  priority: bigint;
};
type BlockTxPool = Map<Uint8Array, Promise<Validation>>;

/**
 * This tx pool is simplified: There's just one set of transactions, that get
 * validated against the best block, but fallbacking to others.
 */
export interface TxPool {
  addTx: (tx: Uint8Array) => Promise<void>;
  getTxsForBlock: (block: Block) => Promise<Uint8Array[]>;
  destroy: () => void;

  txAdded$: Observable<void>;
}

export const createTxPool = (chainP: Chain | Promise<Chain>): TxPool => {
  const blocksTxPool: Record<HexString, BlockTxPool> = {};
  const txAdded$ = new Subject<void>();

  const validateTx = async (
    block: Block,
    tx: Uint8Array
  ): Promise<
    ResultPayload<
      {
        priority: bigint;
        longevity: bigint;
        provides: Array<Uint8Array>;
        requires: Array<Uint8Array>;
      },
      {}
    >
  > => {
    const codec = await getCallCodec(
      block,
      "TaggedTransactionQueue",
      "validate_transaction"
    )!;
    if (!codec)
      throw new Error("TaggedTransactionQueue_validate_transaction required");

    const result = await runRuntimeCall({
      chain: await chainP,
      hash: block.hash,
      call: "TaggedTransactionQueue_validate_transaction",
      params: Binary.toHex(
        codec.args.enc([
          Enum("External", undefined),
          Binary.fromOpaque(tx),
          block.hash,
        ])
      ),
    });

    return codec.value.dec(result.result);
  };

  const getAliveBlocks = async () => {
    const chain = await chainP;
    const [finalized, blocks] = await firstValueFrom(
      combineLatest([chain.finalized$, chain.blocks$])
    );

    const heads: Block[] = [];
    const include = (hash: HexString) => {
      const block = blocks[hash]!;
      heads.push(block);
      block.children.forEach(include);
    };
    include(finalized);
    return heads;
  };

  const subscription = new Subscription();
  subscription.add(
    from(Promise.resolve(chainP))
      .pipe(
        switchMap((chain) =>
          chain.newBlocks$.pipe(withLatestFrom(chain.blocks$))
        )
      )
      .subscribe(([blockHash, blocks]) => {
        const block = blocks[blockHash]!;

        const parentTxPool: BlockTxPool =
          blocksTxPool[block.parent] ?? new Map();
        const txPool: BlockTxPool = (blocksTxPool[block.hash] = new Map());

        parentTxPool.forEach((validation, tx) => {
          if (block.body.includes(tx)) return;
          txPool.set(tx, validation);
        });
      })
  );
  subscription.add(
    from(Promise.resolve(chainP))
      .pipe(switchMap((chain) => finalizedAndPruned$(chain)))
      .subscribe(({ pruned }) =>
        pruned.forEach((hash) => {
          const txPool = blocksTxPool[hash];
          if (!txPool) return;
          txPool.clear();
          delete blocksTxPool[hash];
        })
      )
  );

  return {
    async addTx(tx) {
      const blocks = await getAliveBlocks();

      blocks.forEach((block) => {
        const txPool = (blocksTxPool[block.hash] ??= new Map());
        if (txPool.has(tx)) return;

        txPool.set(
          tx,
          validateTx(block, tx).then((res) => {
            if (!res.success) {
              log.error({ blockHash: block.hash, reason: res.value }, "invalid transaction");
              throw res.value;
            }
            return {
              priority: res.value.priority,
              provides: new Set(res.value.provides.map(Binary.toHex)),
              requires: new Set(res.value.requires.map(Binary.toHex)),
            };
          })
        );
      });

      txAdded$.next();
    },
    getTxsForBlock: async (block) => {
      const blockTxPool = blocksTxPool[block.hash];
      if (!blockTxPool) return [];

      const awaitedTxs = await Promise.all(
        blockTxPool.entries().map(async ([tx, validateP]) => {
          try {
            return { tx, validation: await validateP };
          } catch {
            return { tx, validation: null };
          }
        })
      );

      // prune invalid transactions from the block
      awaitedTxs.forEach((tx) => {
        if (tx.validation == null) {
          blockTxPool.delete(tx.tx);
        }
      });

      const validTxs = awaitedTxs.filter((v) => v.validation != null);

      return sortValidatedTxs(validTxs);
    },
    destroy() {
      subscription.unsubscribe();
      for (const hash in blocksTxPool) {
        blocksTxPool[hash]!.clear();
        delete blocksTxPool[hash];
      }
    },
    txAdded$: txAdded$.asObservable(),
  };
};

const sortValidatedTxs = (
  txs: Array<{
    tx: Uint8Array<ArrayBufferLike>;
    validation: Validation;
  }>
) => {
  const result = txs.filter((tx) => tx.validation.requires.size === 0);
  let pending = txs.filter((tx) => tx.validation.requires.size > 0);

  const providedTags: Record<HexString, bigint> = {};
  const includeTags = (tx: {
    tx: Uint8Array<ArrayBufferLike>;
    validation: Validation;
  }) =>
    tx.validation.provides.forEach((tag) => {
      const p = tx.validation.priority;
      const v = providedTags[tag];
      // Keep the highest priority, as we want to be less restrictive with other txs.
      providedTags[tag] = v == null ? p : v < p ? p : v;
    });
  result.forEach(includeTags);

  let toPromote: typeof result;
  do {
    const pendingPromotion = pending.map((original) => {
      const maxPriority = [...original.validation.requires]
        .map((req) => providedTags[req])
        .reduce(
          (a, b) => (a == null || b == null ? undefined : a > b ? b : a),
          BigInt(Number.MAX_SAFE_INTEGER)
        );
      if (maxPriority == null) {
        return { type: "pending", tx: original };
      }
      return {
        type: "promote",
        tx: {
          ...original,
          validation: {
            ...original.validation,
            // put it below the last tag provider
            priority: maxPriority - 1n,
          },
        },
      };
    });
    toPromote = pendingPromotion
      .filter((pp) => pp.type === "promote")
      .map((pp) => pp.tx);
    pending = pendingPromotion
      .filter((pp) => pp.type === "pending")
      .map((pp) => pp.tx);
    toPromote.forEach((tx) => {
      includeTags(tx);
      result.push(tx);
    });
  } while (toPromote.length > 0);

  const sorted = result.sort((a, b) =>
    Number(b.validation.priority - a.validation.priority)
  );
  // console.log("sorted transactions", sorted);
  return sorted.map((v) => v.tx);
};
