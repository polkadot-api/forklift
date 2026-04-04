import { Blake2256, blockHeader } from "@polkadot-api/substrate-bindings";
import { Binary, type BlockHeader, type HexString } from "polkadot-api";
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
  const height = parent.height + 1;

  const provisionalHeader: BlockHeader = {
    parentHash: parent.hash,
    number: height,
    stateRoot:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    extrinsicRoot:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    // TODO
    digests: [],
  };

  const extrinsics = [
    await timestampInherent(chain, parent),
    await setValidationDataInherent(chain, parent),
    ...params.transactions,
  ].filter((v) => v !== null);

  const result = await buildBlock(
    chain,
    parentHash,
    Binary.toHex(blockHeader.enc(provisionalHeader)),
    extrinsics.map((ext) => Binary.toHex(ext))
  );

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
    body: extrinsics,
    hasNewRuntime: hasNewRuntime || undefined,
    children: [],
  };

  // Update parent's children
  parent.children.push(blockHash);

  return block;
};

const buildBlock = async (
  chain: Chain,
  parentHash: HexString,
  provisionalHeader: HexString,
  extrinsics: HexString[]
): Promise<{
  header: HexString;
  storageDiff: Record<HexString, HexString | null>;
}> => {
  // Call Core_initialize_block
  console.log("Calling initialize block");
  const initResponse = await runRuntimeCall({
    chain,
    hash: parentHash,
    call: "Core_initialize_block",
    params: provisionalHeader,
  });

  // Apply storage changes
  let storageOverrides: Record<HexString, HexString | null> =
    Object.fromEntries(initResponse.storageDiff);

  console.log("Applying extrinsics");
  for (const extrinsic of extrinsics) {
    const applyResponse = await runRuntimeCall({
      chain,
      hash: parentHash,
      call: "BlockBuilder_apply_extrinsic",
      params: extrinsic,
      storageOverrides,
      // Enable mock signature verification to bypass relay chain header seal verification
      mockSignatureHost: true,
    });

    storageOverrides = {
      ...storageOverrides,
      ...Object.fromEntries(applyResponse.storageDiff),
    };
  }

  console.log("Calling finalize block");
  const finalizeResponse = await runRuntimeCall({
    chain,
    hash: parentHash,
    call: "BlockBuilder_finalize_block",
    params: "0x",
    storageOverrides,
  });

  console.log("Block built");

  // Apply finalize storage changes
  storageOverrides = {
    ...storageOverrides,
    ...Object.fromEntries(finalizeResponse.storageDiff),
  };

  return {
    header: finalizeResponse.result,
    storageDiff: storageOverrides,
  };
};
