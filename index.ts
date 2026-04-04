import { Binary, createClient } from "polkadot-api";
import { forklift } from "./src/forklift";
import { aliceSigner } from "./signer";

const fork = forklift({
  source: {
    type: "remote",
    value: {
      url: "wss://sys.ibp.network/asset-hub-paseo",
    },
  },
});

// for (let i = 0; ; i++) {
//   const start = Date.now();
//   const hash = await fork.newBlock();
//   console.log(`block ${i} hash:`, hash);
//   console.log("build time", Date.now() - start);
// }

const client = createClient(fork.serve);
const res = await client
  .getUnsafeApi()
  .tx.System.remark({
    remark: Binary.fromText("Hey")!,
  })
  .signAndSubmit(aliceSigner);

console.log(res);

client.destroy();
