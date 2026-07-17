import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import {
  entropyToMiniSecret,
  mnemonicToEntropy,
} from "@polkadot-labs/hdkd-helpers";
import { getTxCreator } from "polkadot-api/signer";

const alice_mnemonic =
  "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
const entropy = mnemonicToEntropy(alice_mnemonic);
const miniSecret = entropyToMiniSecret(entropy);
const derive = sr25519CreateDerive(miniSecret);
const alice = derive("//Alice");
export const aliceSigner = getTxCreator(alice.publicKey, "Sr25519", alice.sign);

const bob = derive("//Bob");
export const bobSigner = getTxCreator(bob.publicKey, "Sr25519", bob.sign);
