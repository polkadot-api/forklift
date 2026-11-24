import { Binary, Enum, type HexString, type ResultPayload } from "polkadot-api";
import {
  combineLatest,
  firstValueFrom,
  from,
  map,
  Subject,
  Subscription,
  switchMap,
  withLatestFrom,
  type Observable,
} from "rxjs";
import type { Block } from "./block-builder/create-block";
import { finalizedAndPruned$, type Chain } from "./chain";
import { getCallCodec } from "./codecs";
import { blockStorage } from "./executor/chainToStorage";

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

export const createTxPool = (
  chainP: Chain | Promise<Chain>,
  mockSignatureHost?: boolean
): TxPool => {
  const blocksTxPool: Record<HexString, BlockTxPool> = {};
  const txAdded$ = new Subject<void>();
  const aliveTxs = new Map<
    Uint8Array,
    {
      pending: Set<HexString>;
      valid: Set<HexString>;
    }
  >();

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

    const chain = await chainP;
    const result = await chain.executor.runRuntimeCall({
      storage: blockStorage(chain, block.hash),
      call: "TaggedTransactionQueue_validate_transaction",
      params: Binary.toHex(
        codec.args.enc([
          Enum("External", undefined),
          Binary.fromOpaque(tx),
          block.hash,
        ])
      ),
      mockSignatureHost: mockSignatureHost ? 1 : 0,
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

  const evictIfDead = (tx: Uint8Array) => {
    const status = aliveTxs.get(tx);
    if (!status || status.pending.size || status.valid.size) return;
    aliveTxs.delete(tx);
    Object.values(blocksTxPool).forEach((blockTxPool) => blockTxPool.delete(tx));
  };

  const getValidation = (block: Block, tx: Uint8Array) => {
    const validation = validateTx(block, tx).then(async (res) => {
      if (!res.success) {
        const log = (await chainP).logger.child({ module: "txPool" });
        log.error(
          { blockHash: block.hash, reason: res.value },
          "invalid transaction"
        );
        throw res.value;
      }
      return {
        priority: res.value.priority,
        provides: new Set(res.value.provides.map(Binary.toHex)),
        requires: new Set(res.value.requires.map(Binary.toHex)),
      };
    });
    const txStatus = aliveTxs.get(tx) ?? {
      pending: new Set(),
      valid: new Set(),
    };
    aliveTxs.set(tx, txStatus);
    txStatus.pending.add(block.hash);

    const settle = (valid: boolean) => {
      txStatus.pending.delete(block.hash);
      // The block may have stopped being alive while validating
      if (valid && blocksTxPool[block.hash]) txStatus.valid.add(block.hash);
      evictIfDead(tx);
    };
    validation.then(
      () => settle(true),
      () => settle(false)
    );
    return validation;
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

        parentTxPool.forEach((_, tx) => {
          if (block.body.includes(tx)) return;
          txPool.set(tx, getValidation(block, tx));
        });
      })
  );
  subscription.add(
    from(Promise.resolve(chainP))
      .pipe(
        switchMap((chain) =>
          finalizedAndPruned$(chain).pipe(
            map(({ finalized, pruned }) => [
              ...pruned,
              // The previous finalized and the newly finalized ancestors aren't alive anymore
              chain.getBlock(finalized[0]!)!.parent,
              ...finalized.slice(0, -1),
            ])
          )
        )
      )
      .subscribe((dead) => {
        dead.forEach((hash) => {
          aliveTxs.forEach((tx) => {
            tx.pending.delete(hash);
            tx.valid.delete(hash);
          });
          blocksTxPool[hash]?.clear();
          delete blocksTxPool[hash];
        });
        [...aliveTxs.keys()].forEach(evictIfDead);
      })
  );

  return {
    async addTx(tx) {
      const blocks = await getAliveBlocks();

      blocks.forEach((block) => {
        const txPool = (blocksTxPool[block.hash] ??= new Map());
        if (txPool.has(tx)) return;

        txPool.set(tx, getValidation(block, tx));
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

      const validTxs = awaitedTxs.filter((v) => v.validation != null);

      return sortValidatedTxs(validTxs);
    },
    destroy() {
      subscription.unsubscribe();
      for (const hash in blocksTxPool) {
        blocksTxPool[hash]!.clear();
        delete blocksTxPool[hash];
      }
      aliveTxs.clear();
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
