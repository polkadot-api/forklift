import { Blake2256, blockHeader, u64 } from "@polkadot-api/substrate-bindings";
import { Binary, Enum, type BlockHeader, type HexString } from "polkadot-api";
import type { Chain } from "../chain";
import {
  getRuntimeVersion,
  runRuntimeCall,
  type RuntimeVersion,
} from "../executor";
import {
  deleteValue,
  getNode,
  insertValue,
  type StorageNode,
} from "../storage";
import { timestampInherent } from "./timestamp";
import { setValidationDataInherent } from "./set-validation-data";
import { getCurrentSlot } from "./slot-utils";

export interface CreateBlockParams {
  parent: HexString;
  unsafeBlockHeight?: number;
  transactions: Uint8Array[];
  dmp: Uint8Array[];
  hrmp: Record<number, Uint8Array[]>;
  ump: Record<number, Uint8Array[]>;
  storage: Record<HexString, Uint8Array | null>;
}

export interface Block {
  hash: HexString;
  parent: HexString;
  height: number;
  code: Uint8Array;
  storageRoot: StorageNode;
  header: BlockHeader;
  runtime: RuntimeVersion;
  body: Uint8Array[];
  hasNewRuntime?: boolean;
  children: HexString[];
}

const CODE_KEY: HexString = "0x3a636f6465"; // hex-encoded ":code"

export const createBlock = async (
  chain: Chain,
  params: CreateBlockParams
): Promise<Block> => {
  // Determine parent block
  const parentHash = params.parent;
  const parent = chain.getBlock(parentHash);
  if (!parent) throw new Error("Block not found");

  // Create header template for Core_initialize_block
  const height = params.unsafeBlockHeight ?? parent.height + 1;

  const extrinsics = [
    await timestampInherent(chain, parent),
    await setValidationDataInherent(chain, parent),
    ...params.transactions,
  ].filter((v) => v !== null);

  const result = await buildBlock(chain, height, parent, extrinsics);

  // Decode the final header from runtime
  const encodedFinalHeader = Binary.fromHex(result.header);
  const finalHeader = blockHeader.dec(encodedFinalHeader);

  // Compute block hash (Blake2-256 of encoded header)
  const blockHash = Binary.toHex(Blake2256(encodedFinalHeader)) as HexString;

  // Create new storage root from parent's, applying the diff
  let newStorageRoot = parent.storageRoot;
  for (const key in result.storageDiff) {
    const binKey = Binary.fromHex(key as HexString);
    const value = result.storageDiff[key];

    if (value != null) {
      newStorageRoot = insertValue(
        newStorageRoot,
        binKey,
        binKey.length * 2,
        Binary.fromHex(value)
      );
    } else {
      newStorageRoot = deleteValue(newStorageRoot, binKey, binKey.length * 2);
    }
  }

  // Check if runtime code changed
  const codeNode = getNode(
    newStorageRoot,
    Binary.fromHex(CODE_KEY),
    CODE_KEY.length - 2
  );
  if (!codeNode?.value) {
    throw new Error("Unexpected: new block doesn't have code");
  }
  const code = codeNode.value;

  const hasNewRuntime = CODE_KEY in result.storageDiff;
  const runtime = hasNewRuntime
    ? await getRuntimeVersion(code)
    : parent.runtime;

  // Create the new block
  const block: Block = {
    hash: blockHash,
    parent: parentHash,
    height,
    code,
    storageRoot: newStorageRoot,
    header: finalHeader,
    runtime,
    body: result.body,
    hasNewRuntime: hasNewRuntime || undefined,
    children: [],
  };

  // Update parent's children
  parent.children.push(blockHash);

  return block;
};

const buildBlock = async (
  chain: Chain,
  height: number,
  parent: Block,
  extrinsics: Uint8Array[]
) => {
  const parentHash = parent.hash;
  const digests = await buildNextDigests(chain, parent);

  const provisionalHeader: BlockHeader = {
    parentHash,
    number: height,
    stateRoot:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    extrinsicRoot:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    digests,
  };

  console.log("initialise block");
  // Call Core_initialize_block
  const initResponse = await runRuntimeCall({
    chain,
    hash: parentHash,
    call: "Core_initialize_block",
    params: Binary.toHex(blockHeader.enc(provisionalHeader)),
  });

  // Apply storage changes
  let storageOverrides: Record<HexString, HexString | null> =
    Object.fromEntries(initResponse.storageDiff);

  const body: Uint8Array[] = [];
  for (const extrinsic of extrinsics) {
    try {
      console.log("apply extrinsic");
      const applyResponse = await runRuntimeCall({
        chain,
        hash: parentHash,
        call: "BlockBuilder_apply_extrinsic",
        params: Binary.toHex(extrinsic),
        storageOverrides,
        // Enable mock signature verification to bypass relay chain header seal verification
        mockSignatureHost: true,
      });
      body.push(extrinsic);

      storageOverrides = {
        ...storageOverrides,
        ...Object.fromEntries(applyResponse.storageDiff),
      };
    } catch (ex) {
      console.error(ex);
    }
  }

  console.log("finalize block");
  const finalizeResponse = await runRuntimeCall({
    chain,
    hash: parentHash,
    call: "BlockBuilder_finalize_block",
    params: "0x",
    storageOverrides,
  });

  // Apply finalize storage changes
  storageOverrides = {
    ...storageOverrides,
    ...Object.fromEntries(finalizeResponse.storageDiff),
  };

  return {
    header: finalizeResponse.result,
    body,
    storageDiff: storageOverrides,
  };
};

const buildNextDigests = async (chain: Chain, parent: Block) => {
  const currentSlot = await getCurrentSlot(chain, parent);
  const nextSlot = currentSlot + 1n;
  const nextSlotPayload = Binary.toHex(u64.enc(nextSlot));

  if (parent.header.digests.length === 0) {
    return [Enum("preRuntime", { engine: "aura", payload: nextSlotPayload })];
  }

  return parent.header.digests.map((digest) => {
    if (digest.type !== "preRuntime") return digest;
    if (digest.value.engine !== "aura") return digest;

    return Enum("preRuntime", {
      engine: "aura",
      payload: nextSlotPayload,
    });
  });
};
