import { type JsonRpcProvider } from "@polkadot-api/substrate-client";
import { createChain, type NewBlockOptions } from "./chain";
import { createGenesisSource, createRemoteSource } from "./source";
import { runRuntimeCall } from "./executor";
import { getDescendantValues, getDiff } from "./storage";
import { Binary } from "@polkadot-api/substrate-bindings";

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
  getStorageDiff: (
    hash: HexString
  ) => Promise<Record<string, Uint8Array | null>>;
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

  Promise.all([chain, source])
    .then(([chain, source]) => {
      console.log("loading metadata");
      return runRuntimeCall({
        chain,
        hash: source.blockHash,
        call: "Metadata_metadata_at_version",
        params: "0x0f000000",
      });
    })
    .then(
      (r) => console.log(r.length),
      (e) => console.error(e)
    );

  return {
    newBlock: (opts) => chain.then((c) => c.newBlock(opts)),
    changeBest: (hash) => chain.then((c) => c.changeBest(hash)),
    changeFinalized: (hash) => chain.then((c) => c.changeFinalized(hash)),
    setStorage: (hash, changes) =>
      chain.then((c) => c.setStorage(hash, changes)),
    getStorageDiff: (hash) =>
      chain.then(
        (c): Promise<Record<string, Uint8Array<ArrayBufferLike> | null>> => {
          const target = c.getBlock(hash);
          if (!target) {
            throw new Error(`Block not found`);
          }
          const parent = c.getBlock(target.parent);
          if (!parent) {
            throw new Error(`Parent block not loaded`);
          }
          const diff = getDiff(parent.storageRoot, target.storageRoot);
          const inserts = getDescendantValues(
            diff.insert,
            new Uint8Array(),
            0
          ).map(({ key, value }) => [Binary.toHex(key), null]);
          const deletes = diff.deleteValues.map(({ key }) => [
            Binary.toHex(key),
            null,
          ]);
          return Object.fromEntries([...inserts, ...deletes]);
        }
      ),
  } as Forklift;
}
