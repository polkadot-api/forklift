import { forklift } from "./src/forklift";

const fork = forklift({
  source: {
    type: "remote",
    value: {
      url: "wss://sys.ibp.network/asset-hub-polkadot",
      atBlock:
        "0x840cf1bdfa6cee142c695411876ba90ca6ef25493d990ceee4c96db6dc761e31",
    },
  },
});

console.log("create blocks");
const hashA = await fork.newBlock();

console.log("first block hash:", hashA);

const hashB = await fork.newBlock();
console.log("second block hash:", hashB);
