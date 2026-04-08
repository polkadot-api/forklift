import {
  _void,
  Bytes,
  compactNumber,
  Hex,
  Struct,
  Tuple,
  u64,
  Variant,
  Vector,
  type CodecType,
} from "@polkadot-api/substrate-bindings";
import type { Chain } from "../chain";
import { getConstant, getStorageCodecs } from "../codecs";
import { runRuntimeCall } from "../executor";
import type { Block } from "./create-block";

export const getSlotDuration = async (chain: Chain, block: Block) => {
  const babe = await getConstant(block, "Babe", "ExpectedBlockTime");
  if (babe) return BigInt(babe);

  const async = await getConstant(block, "AsyncBacking", "ExpectedBlockTime");
  if (async) return BigInt(async);

  return getAuraSlotDuration(chain, block);
};

export const getCurrentTimestamp = async (chain: Chain, block: Block) => {
  const codecs = await getStorageCodecs(block, "Timestamp", "Now");
  if (!codecs) {
    throw new Error("No Timestamp.Now");
  }

  const node = await chain.getStorage(block.hash, codecs.keys.enc());
  if (node.value != null) {
    const decoded = codecs.value.dec(node.value);
    return typeof decoded === "bigint" ? decoded : BigInt(decoded);
  }

  const fallback = codecs.fallback ?? BigInt(Date.now());
  return typeof fallback === "bigint" ? fallback : BigInt(fallback);
};

export const getCurrentSlot = async (chain: Chain, block: Block) => {
  const [timestamp, slotDuration] = await Promise.all([
    getCurrentTimestamp(chain, block),
    getSlotDuration(chain, block),
  ]);

  return timestamp / slotDuration;
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

const digestVal = Tuple(Hex(4), Hex());

const digest = Variant(
  {
    Other: Bytes(),
    Consensus: digestVal,
    Seal: digestVal,
    PreRuntime: digestVal,
    RuntimeEnvironmentUpdated: _void,
  },
  [0, 4, 5, 6, 8]
);

export const runtimeBlockHeader = Struct({
  parent_hash: Hex(32),
  number: compactNumber,
  state_root: Hex(32),
  extrinsics_root: Hex(32),
  digest: Vector(digest),
});
export type RuntimeBlockHeader = CodecType<typeof runtimeBlockHeader>;
