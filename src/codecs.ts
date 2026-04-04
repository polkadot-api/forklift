import {
  getDynamicBuilder,
  getLookupFn,
  type MetadataLookup,
} from "@polkadot-api/metadata-builders";
import {
  compact,
  decAnyMetadata,
  u32,
  unifyMetadata,
} from "@polkadot-api/substrate-bindings";
import { getExtrinsicDecoder as txUtilsExtrinsicDecoder } from "@polkadot-api/tx-utils";
import { Binary } from "polkadot-api";
import { mergeUint8 } from "polkadot-api/utils";
import { type Block } from "./block-builder/create-block";
import type { Chain } from "./chain";
import { runRuntimeCall } from "./executor";

type DynamicBuilder = ReturnType<typeof getDynamicBuilder>;
const blockMeta = new WeakMap<
  Block,
  {
    metadataRaw: Uint8Array;
    lookup: MetadataLookup;
    dynamicBuilder: DynamicBuilder;
  }
>();

export const setBlockMeta = async (chain: Chain, block: Block) => {
  const parentMeta = blockMeta.get(chain.getBlock(block.parent)!);
  if (!block.hasNewRuntime && parentMeta) {
    blockMeta.set(block, parentMeta);
    return;
  }

  const metadata = await runRuntimeCall({
    chain,
    hash: block.hash,
    call: "Metadata_metadata_at_version",
    params: Binary.toHex(u32.enc(15)),
  });
  const metadataRaw = Binary.fromHex(metadata.result);
  const lookup = getLookupFn(unifyMetadata(decAnyMetadata(metadataRaw)));
  const dynamicBuilder = getDynamicBuilder(lookup);
  blockMeta.set(block, { lookup, dynamicBuilder, metadataRaw });
};

export const getConstant = (
  block: Block,
  palletName: string,
  entryName: string
) => {
  const meta = blockMeta.get(block);
  if (!meta) {
    throw new Error("Block doesn't have metadata set");
  }

  try {
    const codec = meta.dynamicBuilder.buildConstant(palletName, entryName);
    const pallet = meta.lookup.metadata.pallets.find(
      (p) => p.name === palletName
    )!;
    const entry = pallet.constants.find((ct) => ct.name === entryName)!;

    return codec.dec(entry.value);
  } catch (e) {
    // console.error(`getConstant failed for ${palletName}.${entryName}:`, e);
    return null;
  }
};

export const getStorageCodecs = (
  block: Block,
  palletName: string,
  entryName: string
) => {
  const meta = blockMeta.get(block);
  if (!meta) {
    throw new Error("Block doesn't have metadata set");
  }

  try {
    return meta.dynamicBuilder.buildStorage(palletName, entryName);
  } catch {
    return null;
  }
};

export const getTxCodec = (
  block: Block,
  palletName: string,
  txName: string
) => {
  const meta = blockMeta.get(block);
  if (!meta) {
    throw new Error("Block doesn't have metadata set");
  }

  try {
    return meta.dynamicBuilder.buildCall(palletName, txName);
  } catch (ex) {
    return null;
  }
};

export const getCallData = (
  block: Block,
  palletName: string,
  txName: string,
  params: any
) => {
  const tx = getTxCodec(block, palletName, txName);
  if (!tx) return null;

  try {
    const { location, codec } = tx;

    return mergeUint8([new Uint8Array(location), codec.enc(params)]);
  } catch (ex) {
    console.error(ex);
    return null;
  }
};

export const getExtrinsicDecoder = (block: Block) => {
  const meta = blockMeta.get(block);
  if (!meta) {
    throw new Error("Block doesn't have metadata set");
  }

  return txUtilsExtrinsicDecoder(meta.metadataRaw);
};

export const unsignedExtrinsic = (callData: Uint8Array) =>
  mergeUint8([compact.enc(callData.length + 1), new Uint8Array([4]), callData]);
