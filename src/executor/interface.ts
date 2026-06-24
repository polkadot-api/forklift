import { type HexString } from "polkadot-api";

export interface Executor {
  runRuntimeCall(params: RuntimeCallParams): Promise<RuntimeCallResult>;
  getRuntimeVersion(code: Uint8Array): Promise<RuntimeVersion>;
  createProof: (
    nodes: HexString[],
    updates: [HexString, HexString | null][]
  ) => Promise<[HexString, HexString[]]>;
  decodeProof: (
    trieRootHash: HexString,
    nodes: HexString[]
  ) => Promise<[[HexString, HexString]]>;
}

export interface RuntimeCallParams {
  storage: {
    code: Uint8Array;
    getValue(key: HexString): Promise<Uint8Array | null>;
    getDescendantKeys(prefix: HexString): Promise<HexString[]>;
  };
  call: string;
  params: HexString;
  storageOverrides?: Record<HexString, HexString | null>;
  mockSignatureHost?: 0 | 1 | 2;
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

export interface RuntimeCallResult {
  result: HexString;
  storageDiff: Array<[HexString, HexString | null]>;
  offchainStorageDiff: Array<[HexString, HexString | null]>;
  runtimeLogs: string[];
}

export interface TaskResponse {
  Call?: RuntimeCallResult;
  Error?: string;
}
