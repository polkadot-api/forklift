import { forklift } from "./src/forklift";
import { createWsServer } from "./src/serve";

// MultiBlockElection.CurrentPhase suspicious of triggering a slow initialised

const assetHubFork = forklift(
  {
    type: "remote",
    value: {
      url: "wss://sys.ibp.network/asset-hub-paseo",
    },
  },
  {
    key: "ahPas",
    disableOnIdle: true,
  }
);
const assetHubServer = createWsServer(assetHubFork);
console.log("AssetHub listening at", assetHubServer.port);

// const bridgeHubFork = forklift(
//   {
//     type: "remote",
//     value: {
//       url: "wss://bridge-hub-paseo.ibp.network",
//     },
//   },
//   {
//     key: "bhPas",
//   }
// );
// const bridgeHubServer = createWsServer(bridgeHubFork);
// console.log("BridgeHub listening at", bridgeHubServer.port);

// const assetHubClient = createClient(assetHubFork.serve);
// await assetHubFork.setStorage((await assetHubClient.getFinalizedBlock()).hash, {
//   ["0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da94f9aea1afa791265fae359272badc1cf8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48"]:
//     Binary.fromHex(
//       "0x000000000000000001000000000000000010a5d4e80000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000080"
//     ),
// });

// const parachainClient = createClient(assetHubFork.serve);
// await parachainClient._request("forklift_xcm_attach_sibling", [
//   `ws://localhost:${bridgeHubServer.port}`,
// ]);

// // // DMP
// // try {
// //   const tx = await relayClient
// //     .getUnsafeApi()
// //     .txFromCallData(Binary.fromHex("0x630004000100a10f04040a"));
// //   const txResult = await tx.signAndSubmit(bobSigner);
// //   console.log("Tx finished", txResult);
// // } catch {}

// // // UMP
// // try {
// //   const tx = await parachainClient
// //     .getUnsafeApi()
// //     .txFromCallData(
// //       Binary.fromHex(
// //         "0x1f0905010005000101008eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48050401000002286bee0000000000"
// //       )
// //     );
// //   // .txFromCallData(Binary.fromHex("0x1f0004010004040a"));
// //   const txResult = await tx.signAndSubmit(bobSigner);
// //   console.log("Tx finished", txResult);
// // } catch {}

// // HRMP
// try {
//   const tx = await assetHubClient
//     .getUnsafeApi()
//     .txFromCallData(
//       Binary.fromHex(
//         "0x1f0905010100a90f05000101008eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48050401000002286bee0000000000"
//       )
//     );
//   const txResult = await tx.signAndSubmit(bobSigner);
//   console.log("Tx finished", txResult);
// } catch {}
