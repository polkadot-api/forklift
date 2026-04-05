import { AccountId, Binary, createClient } from "polkadot-api";
import { forklift } from "./src/forklift";
import { aliceSigner } from "./signer";

const fork = forklift({
  type: "remote",
  value: {
    url: "wss://sys.ibp.network/asset-hub-paseo",
  },
});

const client = createClient(fork.serve);
client.blocks$.subscribe((b) => console.log("blocks", b));

console.log("push first");
await client.getUnsafeApi().tx.System!.remark!({
  remark: Binary.fromText("Hey")!,
}).signAndSubmit(aliceSigner);

console.log("push second");
await client.getUnsafeApi().tx.System!.remark!({
  remark: Binary.fromText("Hey")!,
}).signAndSubmit(aliceSigner);

const [bestBlock] = await client.getBestBlocks();

console.log(await fork.getStorageDiff(bestBlock!.hash));

client.destroy();
fork.destroy();
