import { type JsonRpcProvider } from "@polkadot-api/substrate-client";
import { Binary, type HexString } from "polkadot-api";
import { createChain, type NewBlockOptions } from "./chain";
import { createServer } from "./serve";
import { createGenesisSource, createRemoteSource } from "./source";
import { getDescendantNodes, getDiff } from "./storage";

export enum BuildBlockMode {
  Batch = "Batch",
  Instant = "Instant",
  Manual = "Manual",
}

export interface Forklift {
  serve: JsonRpcProvider;

  newBlock: (opts?: Partial<NewBlockOptions>) => Promise<HexString>;
  changeBest: (hash: HexString) => Promise<void>;
  changeFinalized: (hash: HexString) => Promise<void>;
  setStorage: (
    hash: HexString,
    changes: Record<string, Uint8Array>
  ) => Promise<void>;
  getStorageDiff: (
    hash: HexString,
    baseHash?: HexString
  ) => Promise<
    Record<string, { value: Uint8Array | null; prev?: Uint8Array | null }>
  >;
  setBuildBlockMode: (mode: BuildBlockMode) => void;
}

export interface ForkliftParams {
  source:
    | {
        type: "remote";
        value: {
          url: string | string[];
          atBlock?: number | string;
        };
      }
    | {
        type: "genesis";
        value: Record<string, string>;
      };
  buildBlockMode?: BuildBlockMode;
  mockSignatureHost?: (signature: Uint8Array) => boolean;
}

export function forklift(params: ForkliftParams): Forklift {
  const source =
    params.source.type === "remote"
      ? createRemoteSource(params.source.value.url, {
          atBlock: params.source.value.atBlock,
        })
      : createGenesisSource();
  const chain = createChain(source);

  return {
    serve: createServer(chain),
    newBlock: (opts) => chain.then((c) => c.newBlock(opts)),
    changeBest: (hash) => chain.then((c) => c.changeBest(hash)),
    changeFinalized: (hash) => chain.then((c) => c.changeFinalized(hash)),
    setStorage: (hash, changes) =>
      chain.then((c) => c.setStorage(hash, changes)),
    getStorageDiff: (hash, baseHash) =>
      chain.then((c) => c.getStorageDiff(hash, baseHash)),
  } as Forklift;
}
