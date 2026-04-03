import { u64 } from "@polkadot-api/substrate-bindings";
import type { Chain } from "../chain";
import {
  getCallData,
  getConstant,
  getStorageCodecs,
  unsignedExtrinsic,
} from "../codecs";
import { runRuntimeCall } from "../executor";
import type { Block } from "./create-block";

export const timestampInherent = async (chain: Chain, parentBlock: Block) => {
  const now = await getNextTimestamp(chain, parentBlock);

  const callData = getCallData(parentBlock, "Timestamp", "set", {
    now,
  });
  return callData && unsignedExtrinsic(callData);
};

const getNextTimestamp = async (chain: Chain, block: Block) => {
  const currentSlotCodec = getStorageCodecs(block, "Aura", "CurrentSlot");
  if (!currentSlotCodec) {
    const [slotDuration, timestamp] = await Promise.all([
      getSlotDuration(chain, block),
      getTimestamp(chain, block),
    ]);
    return timestamp + slotDuration;
  }

  const [currentSlotNode, slotDuration] = await Promise.all([
    chain.getStorage(block.hash, currentSlotCodec.keys.enc()),
    getAuraSlotDuration(chain, block),
  ]);
  const currentSlot: bigint = currentSlotCodec.value.dec(
    currentSlotNode.value!
  );
  return currentSlot * slotDuration;
};

const getSlotDuration = async (chain: Chain, block: Block) => {
  const babe = getConstant(block, "Babe", "ExpectedBlockTime");
  if (babe) return BigInt(babe);

  const async = getConstant(block, "AsyncBacking", "ExpectedBlockTime");
  if (async) return BigInt(async);

  return getAuraSlotDuration(chain, block);
};

const getAuraSlotDuration = async (chain: Chain, block: Block) => {
  try {
    const { result } = await runRuntimeCall({
      chain,
      hash: block.hash,
      call: "AuraApi_slot_duration",
      params: "0x",
    });

    return u64.dec(result);
  } catch {}

  console.error("Couldn't get aura slot duration");
  return 12_000n;
};

const getTimestamp = async (chain: Chain, block: Block): Promise<bigint> => {
  const codecs = getStorageCodecs(block, "Timestamp", "Now");
  if (!codecs) {
    throw new Error("Timestamp.Now not available");
  }

  const node = await chain.getStorage(block.hash, codecs.keys.enc());
  return node.value ? codecs.value.dec(node.value) : codecs.fallback;
};
