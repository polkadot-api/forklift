import { Binary, createClient } from "polkadot-api";
import { forklift } from "./src/forklift";
import { createWsServer } from "./src/serve";
import { bobSigner } from "./signer";

const relayFork = forklift(
  {
    type: "remote",
    value: {
      url: "wss://rpc-polkadot.helixstreet.io",
    },
  },
  {
    disableOnIdle: true,
    key: "dot",
  }
);
const relayServer = createWsServer(relayFork);
console.log("Relay listening at", relayServer.port);

const parachainFork = forklift(
  {
    type: "remote",
    value: {
      url: "wss://sys.ibp.network/asset-hub-paseo",
    },
  },
  {
    disableOnIdle: true,
    key: "ahDot",
  }
);
const parachainServer = createWsServer(parachainFork);
console.log("Parachain listening at", parachainServer.port);

const relayClient = createClient(relayFork.serve);
await relayFork.setStorage((await relayClient.getFinalizedBlock()).hash, {
  ["0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da94f9aea1afa791265fae359272badc1cf8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48"]:
    Binary.fromHex(
      "0x000000000000000001000000000000000010a5d4e80000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000080"
    ),
});

const tx = await relayClient
  .getUnsafeApi()
  .txFromCallData(Binary.fromHex("0x630004000100a10f04040a"));

const parachainClient = createClient(parachainFork.serve);
parachainClient._request("forklift_xcm_attach_relay", [
  `ws://localhost:${relayServer.port}`,
]);

try {
  const txResult = await tx.signAndSubmit(bobSigner);
  console.log("Tx finished", txResult);
} catch {}
