import { Binary, Enum, type ResultPayload } from "polkadot-api";
import {
  BehaviorSubject,
  combineLatest,
  firstValueFrom,
  Observable,
} from "rxjs";
import type { Block } from "./block-builder/create-block";
import type { Chain } from "./chain";
import { getCallCodec } from "./codecs";
import { runRuntimeCall } from "./executor";

export interface ValidatedTx {
  extrinsic: Uint8Array;
  validatedAgainst: Block;
  priority: bigint;
  longevity: bigint;
  includedAt?: Block;
}

/**
 * This tx pool is simplified: There's just one set of transactions, that get
 * validated against the best block, but fallbacking to others.
 */
export interface TxPool {
  addTx: (tx: Uint8Array) => Promise<ValidatedTx>;
  getTxsForBlock: (block: Block) => Promise<Uint8Array[]>;
  markIncluded: (tx: Uint8Array, block: Block) => void;

  txs$: Observable<ValidatedTx[]>;
}

export const createTxPool = (chainP: Chain | Promise<Chain>): TxPool => {
  const txs$ = new BehaviorSubject<ValidatedTx[]>([]);

  const validateTx = async (
    block: Block,
    tx: Uint8Array
  ): Promise<
    ResultPayload<
      {
        priority: bigint;
        longevity: bigint;
      },
      {}
    >
  > => {
    const codec = getCallCodec(
      block,
      "TaggedTransactionQueue",
      "validate_transaction"
    )!;
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

  return {
    async addTx(tx) {
      const chain = await chainP;
      const [best, finalized, blocks] = await firstValueFrom(
        combineLatest([chain.best$, chain.finalized$, chain.blocks$])
      );
      const bestBlock = blocks[best]!;
      const bestValid = await validateTx(bestBlock, tx);
      console.log("bestValid", bestValid);

      if (bestValid.success) {
        const validatedTx: ValidatedTx = {
          extrinsic: tx,
          longevity: bestValid.value.longevity,
          priority: bestValid.value.priority,
          validatedAgainst: bestBlock,
        };
        txs$.next([...txs$.getValue(), validatedTx]);
        return validatedTx;
      }
      // TODO try other blocks
      throw new Error("Transaction invalid");
    },
    getTxsForBlock: async (block) => [],
    markIncluded: (tx: Uint8Array, block: Block) => {},

    txs$,
  };
};
