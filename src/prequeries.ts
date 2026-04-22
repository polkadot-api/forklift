import { switchMap, take, withLatestFrom } from "rxjs";
import type { Chain } from "./chain";
import { getStorageCodecs } from "./codecs";

const prequeries = ["Mmr.Nodes", "Paras.Heads"];

export const runPrequeries = (chain: Chain) => {
  chain.finalized$.pipe(take(1)).subscribe({
    next: async (hash) => {
      const block = chain.getBlock(hash)!;
      for (const pre of prequeries) {
        const [pallet, entry] = pre.split(".");
        const codec = await getStorageCodecs(block, pallet!, entry!);
        if (codec) {
          chain.getStorageDescendants(hash, codec.keys.enc()).catch(() => {});
        }
      }
    },
    error: () => {},
  });
};
