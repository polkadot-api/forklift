import { forklift } from "./src/forklift";

const fork = forklift({
  source: {
    type: "remote",
    value: {
      url: "wss://sys.ibp.network/asset-hub-polkadot",
    },
  },
});
