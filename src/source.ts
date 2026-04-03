import { createClient } from "@polkadot-api/substrate-client";
import { middleware } from "@polkadot-api/ws-middleware";
import { getWsProvider, SocketEvents } from "@polkadot-api/ws-provider";
import { Binary, type BlockHeader, type HexString } from "polkadot-api";
import { blockHeader } from "@polkadot-api/substrate-bindings";

export interface Source {
  /** The block hash this source is pinned to */
  blockHash: HexString;

  /** The block header */
  header: BlockHeader;

  body: Uint8Array[];

  /** Get a single storage value */
  getStorage(key: HexString): Promise<Uint8Array | null>;

  /** Get multiple storage values */
  getStorageBatch(keys: HexString[]): Promise<(Uint8Array | null)[]>;

  /** Get all storage entries under a prefix */
  getStorageDescendants(
    prefix: HexString
  ): Promise<Record<HexString, Uint8Array>>;

  /** Disconnect from the source */
  disconnect(): void;
}

const queries = new Array<string>();
const descendants = new Array<string>();
// setInterval(() => {
//   queries.sort();
//   console.log(JSON.stringify({ queries, descendants }));
// }, 5000);

export const createRemoteSource = async (
  url: string | string[],
  options: {
    atBlock?: number | string;
  } = {}
): Promise<Source> => {
  const substrateClient = createClient(
    getWsProvider(url, {
      middleware,
      logger: (evt) => {
        if (evt.type !== SocketEvents.IN && evt.type !== SocketEvents.OUT)
          console.log(evt);
      },
    })
  );
  const archive = substrateClient.archive;

  // Resolve the block hash
  let blockHash: HexString;
  // working
  // options.atBlock =
  //   "0x7160c5851e4fc899bfce84331f4dda4ea092841c0f21f4853eb5ecbf6f9f659a";
  // not working
  options.atBlock =
    "0x0f2e70e972b62107dc0315df2c161dd5a97f7d372fed2cd2cacff4178344ea72";

  if (options.atBlock === undefined) {
    const finalizedHeight = await archive.finalizedHeight();
    const hashes = await archive.hashByHeight(finalizedHeight);
    const hash = hashes[0];
    if (!hash) {
      throw new Error(`No block found at finalized height ${finalizedHeight}`);
    }
    blockHash = hash;
  } else if (typeof options.atBlock === "number") {
    const hashes = await archive.hashByHeight(options.atBlock);
    const hash = hashes[0];
    if (!hash) {
      throw new Error(`No block found at height ${options.atBlock}`);
    }
    blockHash = hash;
  } else {
    blockHash = options.atBlock;
  }

  // Fetch and decode the header
  console.log(`Loading block ${blockHash}`);
  const headerHex = await archive.header(blockHash);
  const header = blockHeader.dec(Binary.fromHex(headerHex));
  console.log(`Initial block loaded`);

  const body = await archive.body(blockHash);

  return {
    blockHash,
    header,
    body: body.map((v) => Binary.fromHex(v)),

    async getStorage(key: HexString): Promise<Uint8Array | null> {
      queries.push(key);
      const value = await archive.storage(blockHash, "value", key, null);
      return value ? Binary.fromHex(value) : null;
    },

    async getStorageBatch(keys: HexString[]): Promise<(Uint8Array | null)[]> {
      console.log("get batch");
      return new Promise((resolve, reject) => {
        const results = new Map<string, Uint8Array | null>();
        const inputs = keys.map((key) => ({ key, type: "value" as const }));

        const unsub = archive.storageSubscription(
          blockHash,
          inputs,
          null,
          (item) => {
            results.set(
              item.key,
              item.value ? Binary.fromHex(item.value) : null
            );
          },
          reject,
          () => {
            resolve(keys.map((key) => results.get(key) ?? null));
            unsub();
          }
        );
      });
    },

    async getStorageDescendants(
      prefix: HexString
    ): Promise<Record<HexString, Uint8Array>> {
      if (prefix.length < 10) {
        throw new Error("Descendants too broad");
      }
      descendants.push(prefix);

      const entries = await archive.storage(
        blockHash,
        "descendantsValues",
        prefix,
        null
      );
      const result: Record<HexString, Uint8Array> = {};
      for (const { key, value } of entries) {
        result[key] = Binary.fromHex(value);
      }
      return result;
    },

    disconnect(): void {
      substrateClient.destroy();
    },
  };
};

export const createGenesisSource = async () => {
  throw new Error("Not implemented");
};
