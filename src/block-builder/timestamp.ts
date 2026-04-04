import type { Chain } from "../chain";
import { getCallData, unsignedExtrinsic } from "../codecs";
import type { Block } from "./create-block";
import { getCurrentTimestamp, getSlotDuration } from "./slot-utils";

export const timestampInherent = async (chain: Chain, parentBlock: Block) => {
  const now = await getNextTimestamp(chain, parentBlock);

  const callData = getCallData(parentBlock, "Timestamp", "set", {
    now,
  });
  return callData && unsignedExtrinsic(callData);
};

const getNextTimestamp = async (chain: Chain, block: Block) => {
  const [slotDuration, timestamp] = await Promise.all([
    getSlotDuration(chain, block),
    getCurrentTimestamp(chain, block),
  ]);
  return timestamp + slotDuration;
};
