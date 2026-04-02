import {
  get_runtime_version,
  run_task,
  type JsCallback,
} from "@acala-network/chopsticks-executor";
import { Binary, type HexString } from "polkadot-api";
import type { Chain } from "./chain";

export interface ExecutorParams {
  chain: Chain;
  hash: HexString;
  call: string;
  params: HexString;
  mockSignatureHost?: boolean;
}

export interface RuntimeVersion {
  specName: string;
  implName: string;
  authoringVersion: number;
  specVersion: number;
  implVersion: number;
  apis: Array<[HexString, number]>;
  transactionVersion: number;
  stateVersion: number;
}

interface TaskResponse {
  Call?: {
    result: HexString;
    storageDiff: Array<[HexString, HexString | null]>;
    offchainStorageDiff: Array<[HexString, HexString | null]>;
    runtimeLogs: string[];
  };
  Error?: string;
}

let nextTaskId = 0;
export const runRuntimeCall = async ({
  chain,
  hash,
  call,
  params,
  mockSignatureHost = false,
}: ExecutorParams): Promise<HexString> => {
  // Get the runtime code for the target block
  const code = await chain.getBlock(hash)?.code;
  if (!code) {
    throw new Error(`No runtime code found at block ${hash}`);
  }
  const codeHex = Binary.toHex(code);

  // Create the callback object for storage access
  const jsCallback = createJsCallback(chain, hash);

  // Build the task
  const task = {
    id: nextTaskId++,
    wasm: codeHex,
    calls: [[call, [params]]],
    // 0: no mock, 1: require magic signature, 2: always valid
    mockSignatureHost: mockSignatureHost ? 2 : 0,
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

  return response.Call.result;
};

export const getRuntimeVersion = async (
  code: Uint8Array
): Promise<RuntimeVersion> => {
  const codeHex = Binary.toHex(code);

  const version = await get_runtime_version(codeHex);
  return version as RuntimeVersion;
};

const createJsCallback = (chain: Chain, hash: HexString): JsCallback => {
  return {
    async getStorage(key: HexString): Promise<string | undefined> {
      const node = await chain.getStorage(hash, key);
      return node.value ? Binary.toHex(node.value) : undefined;
    },

    async getNextKey(
      prefix: HexString,
      key: HexString
    ): Promise<string | undefined> {
      // Get all descendants under the prefix and find the next key after `key`
      const descendants = await chain.getStorageDescendants(hash, prefix);
      const keys = Object.keys(descendants).sort();
      const idx = keys.findIndex((k) => k > key);
      return idx >= 0 ? keys[idx] : undefined;
    },

    async offchainGetStorage(_key: HexString): Promise<string | undefined> {
      // Offchain storage not implemented
      return undefined;
    },

    async offchainTimestamp(): Promise<number> {
      return Date.now();
    },

    async offchainRandomSeed(): Promise<`0x${string}`> {
      // Return a pseudo-random seed
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      return Binary.toHex(bytes) as `0x${string}`;
    },

    async offchainSubmitTransaction(_tx: HexString): Promise<boolean> {
      // Transaction submission not implemented
      return false;
    },
  };
};
