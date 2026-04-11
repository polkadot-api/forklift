import { Binary, createClient } from "polkadot-api";
import { forklift } from "./src/forklift";
import { createWsServer } from "./src/serve";
import { bobSigner } from "./signer";

const relayFork = forklift(
  {
    type: "remote",
    value: {
      url: "wss://rpc.ibp.network/paseo",
      atBlock:
        "0xd349005f972e0b9a5f3de45657fad1d4a141c99aa5b6e12bf1519c89429c19f0",
    },
  },
  {
    disableOnIdle: true,
    key: "pas",
  }
);
const relayServer = createWsServer(relayFork);
console.log("Relay listening at", relayServer.port);

const parachainFork = forklift(
  {
    type: "remote",
    value: {
      url: "wss://sys.ibp.network/asset-hub-paseo",
      atBlock:
        "0xfa78773bedf434bccaec08bb577352577a975a983188a8a70f4589951ca6da33",
    },
  },
  {
    disableOnIdle: true,
    key: "ahPas",
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

const parachainClient = createClient(parachainFork.serve);
parachainClient._request("forklift_xcm_attach_relay", [
  `ws://localhost:${relayServer.port}`,
]);

// // DMP
// try {
//   const tx = await relayClient
//     .getUnsafeApi()
//     .txFromCallData(Binary.fromHex("0x630004000100a10f04040a"));
//   const txResult = await tx.signAndSubmit(bobSigner);
//   console.log("Tx finished", txResult);
// } catch {}

// UMP
try {
  const tx = await parachainClient
    .getUnsafeApi()
    .txFromCallData(
      Binary.fromHex(
        "0x1f0905010005000101008eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48050401000002286bee0000000000"
      )
    );
  // .txFromCallData(Binary.fromHex("0x1f0004010004040a"));
  const txResult = await tx.signAndSubmit(bobSigner);
  console.log("Tx finished", txResult);
} catch {}

// Teleport 1 dot from AH to relay, beneficiary bob
// 0x1f0905010005000101008eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48050401000002286bee0000000000

// Heap {ching
//   newMsgTotalSize: 137,
//   lastMsgOffset: 149,
// } 0x5e000000000514020400000002286bee0a1300000002286bee000d010204000101008eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a482c9c963a839188c280fe27c8bf4d8df9f1cef8030b7f7c8c30fdb3833c5b381af4000000000028000000000198002408011220a5a81dd42dd04a2631de9bd26d2fd7b4dab0e23c142376913d22d010c4ee8fe10300000000000001
