import { createClient } from "polkadot-api";
import { forklift } from "./src/forklift";
import { withLogsRecorder } from "polkadot-api/logs-provider";

const fork = forklift({
  source: {
    type: "remote",
    value: {
      url: "wss://sys.ibp.network/asset-hub-polkadot",
    },
  },
});

const client = createClient(withLogsRecorder(console.log, fork.serve));
