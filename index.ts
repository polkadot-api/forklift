import { forklift } from "./src/forklift";

const fork = forklift({
  source: {
    type: "remote",
    value: {
      url: "wss://sys.ibp.network/asset-hub-polkadot",
    },
  },
});

console.log("Starting newBlock test...");
fork
  .newBlock()
  .then((hash) => {
    console.log("\n\n========== NEW BLOCK CREATED ==========");
    console.log("Hash:", hash);
    console.log("========================================\n\n");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n\n========== ERROR ==========");
    console.error(err);
    console.error("===========================\n\n");
    process.exit(1);
  });
