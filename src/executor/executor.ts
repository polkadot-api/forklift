import {
  create_proof,
  decode_proof,
  get_runtime_version,
  run_task,
  type JsCallback,
} from "@acala-network/chopsticks-executor";
import { Binary, type HexString } from "polkadot-api";
import type { Executor, RuntimeCallParams, TaskResponse } from "./interface";

let nextTaskId = 0;
export const executor: Executor = {
  async runRuntimeCall({
    storage,
    call,
    params,
    storageOverrides = {},
    mockSignatureHost = 0,
  }) {
    const codeHex = Binary.toHex(storage.code);

    // Create the callback object for storage access
    const jsCallback = createJsCallback(storage, storageOverrides);

    // Build the task
    const task = {
      id: nextTaskId++,
      wasm: codeHex,
      calls: [[call, [params]]],
      // 0: no mock, 1: require magic signature, 2: always valid
      mockSignatureHost,
      allowUnresolvedImports: true,
      runtimeLogLevel: 0,
      storageProofSize: 1000,
    };

    // Run the task
    const response = (await run_task(task, jsCallback)) as TaskResponse;

    if (response.Error) {
      throw new Error(`Runtime call failed: ${response.Error}`);
    }

    if (!response.Call) {
      throw new Error("Unexpected response format from runtime");
    }

    return response.Call;
  },
  async getRuntimeVersion(code) {
    const codeHex = Binary.toHex(code);

    const version = await get_runtime_version(codeHex);
    return version;
  },
  createProof(nodes, updates) {
    return create_proof(nodes, updates);
  },
  decodeProof(trieRootHash, nodes) {
    return decode_proof(trieRootHash, nodes);
  },
};

const MIN_PREFIX_LEN = 32 * 2 + 2; // module + method + 0x
const createJsCallback = (
  storage: RuntimeCallParams["storage"],
  overlay: Record<HexString, HexString | null>
): JsCallback => {
  return {
    async getStorage(key: HexString): Promise<string | undefined> {
      // console.log("get", key);

      // Check overlay first
      if (key in overlay) {
        return overlay[key] ?? undefined;
      }
      const value = await storage.getValue(key);
      return value ? Binary.toHex(value) : undefined;
    },

    async getNextKey(
      prefix: HexString,
      key: HexString
    ): Promise<string | undefined> {
      prefix =
        prefix.length < MIN_PREFIX_LEN ? key.slice(0, MIN_PREFIX_LEN) : prefix;

      // Get all descendants under the prefix and find the next key after `key`
      const descendants = await storage.getDescendantKeys(prefix);

      // Merge with overlay
      const allKeys = new Set([
        ...descendants,
        ...Object.keys(overlay).filter(
          (k) => k.startsWith(prefix) && overlay[k] !== null
        ),
      ]);
      // Remove keys that are deleted in overlay
      for (const k of Object.keys(overlay)) {
        if (overlay[k] === null) allKeys.delete(k);
      }
      const keys = [...allKeys].sort();
      const idx = keys.findIndex((k) => k > key);
      return idx >= 0 ? keys[idx] : undefined;
    },

    async offchainGetStorage(_key: HexString): Promise<string | undefined> {
      return undefined;
    },

    async offchainTimestamp(): Promise<number> {
      return Date.now();
    },

    async offchainRandomSeed(): Promise<`0x${string}`> {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      return Binary.toHex(bytes) as `0x${string}`;
    },

    async offchainSubmitTransaction(_tx: HexString): Promise<boolean> {
      return false;
    },
  };
};
