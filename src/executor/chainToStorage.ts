import type { HexString } from "polkadot-api";
import type { Chain } from "../chain";
import type { RuntimeCallParams } from "./interface";

export const blockStorage = (
  chain: Chain,
  hash: HexString
): RuntimeCallParams["storage"] => {
  const code = chain.getBlock(hash)?.code;
  if (!code) {
    throw new Error(`No runtime code found at block ${hash}`);
  }

  return {
    code,
    async getDescendantKeys(prefix) {
      const descendants = await chain.getStorageDescendants(hash, prefix);
      return Object.keys(descendants);
    },
    async getValue(key) {
      const node = await chain.getStorage(hash, key);
      return node.value ?? null;
    },
  };
};
