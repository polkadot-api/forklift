import { type JsonRpcProvider } from "@polkadot-api/substrate-client";
import { createChain, type NewBlockOptions } from "./chain";
import { createGenesisSource, createRemoteSource } from "./source";

type HexString = string;
export enum BuildBlockMode {
  Batch = "Batch",
  Instant = "Instant",
  Manual = "Manual",
}

export interface Forklift {
  serve: JsonRpcProvider;
  newBlock: (opts?: Partial<NewBlockOptions>) => Promise<void>;
  changeBest: (hash: HexString) => Promise<void>;
  changeFinalized: (hash: HexString) => Promise<void>;
  setStorage: (
    hash: HexString,
    changes: Record<string, Uint8Array>
  ) => Promise<void>;
  getStorageDiff: (hash: HexString) => Promise<Record<string, Uint8Array>>;
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
    newBlock: (opts) => chain.then((c) => c.newBlock(opts)),
    changeBest: (hash) => chain.then((c) => c.changeBest(hash)),
    changeFinalized: (hash) => chain.then((c) => c.changeFinalized(hash)),
  } as Forklift;
}
