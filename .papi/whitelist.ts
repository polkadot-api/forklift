import type { WhitelistEntriesByChain } from "./descriptors";

export const whitelist: WhitelistEntriesByChain = {
  relay: ["query.Dmp.DownwardMessageQueues"],
  parachain: [
    "query.ParachainSystem.UpwardMessages",
    "query.ParachainSystem.HrmpOutboundMessages",
    "const.ParachainSystem.SelfParaId",
  ],
};
