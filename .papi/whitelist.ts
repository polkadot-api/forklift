import type { WhitelistEntriesByChain } from "@polkadot-api/descriptors";

export const whitelist: WhitelistEntriesByChain = {
  relay: ["query.Dmp.DownwardMessageQueues"],
  parachain: [],
};
