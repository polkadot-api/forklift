import { Binary, createClient, Enum } from "polkadot-api";
import { forklift } from "./src/forklift";
import { createServer } from "./src/server";
import { bobSigner } from "./signer";

const relay = forklift(
  {
    type: "remote",
    value: {
      url: "wss://polkadot.ibp.network",
    },
  },
  {
    disableOnIdle: true,
    key: "relay",
  }
);
const relayServer = createServer(relay, { port: 3000 });
console.log("listening relay on port", relayServer.port);

const relayClient = createClient(relay.serve);

await relay.setStorage((await relayClient.getFinalizedBlock()).hash, {
  ["0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da94f9aea1afa791265fae359272badc1cf8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48"]:
    Binary.fromHex(
      "0x000000000000000001000000000000000010a5d4e80000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000080"
    ),
});

const tx = await relayClient
  .getUnsafeApi()
  .txFromCallData(Binary.fromHex("0x630004000100a10f04040a"));

try {
  const txResult = await tx.signAndSubmit(bobSigner);
  console.log("Tx finished", txResult);
} catch {}

const assetHub = forklift(
  {
    type: "remote",
    value: {
      url: "wss://sys.ibp.network/asset-hub-polkadot",
    },
  },
  {
    disableOnIdle: true,
    key: "assetHub",
    async xcmProvider() {
      const relayXcm = await relay.getXcm();

      return {
        dmp: relayXcm.dmp[1000] ?? [],
        hrmp: [],
        ump: {},
      };
    },
  }
);
const assetHubServer = createServer(assetHub, { port: 3001 });
console.log("listening assetHub on port", assetHubServer.port);

setTimeout(async () => {
  console.log("Create block");
  await assetHub.newBlock();
}, 3000);
