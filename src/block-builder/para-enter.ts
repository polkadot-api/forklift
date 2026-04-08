import { blockHeader } from "@polkadot-api/substrate-bindings";
import type { Chain } from "../chain";
import { getCallData, unsignedExtrinsic } from "../codecs";
import type { Block } from "./create-block";
import { runtimeBlockHeader } from "./slot-utils";

export const paraInherentEnterInherent = async (
  _chain: Chain,
  parentBlock: Block
) => {
  const parent_header = runtimeBlockHeader.dec(
    blockHeader.enc(parentBlock.header)
  );

  const callData = await getCallData(parentBlock, "ParaInherent", "enter", {
    data: {
      bitfields: [],
      backed_candidates: [],
      disputes: [],
      parent_header,
    },
  });
  return callData ? unsignedExtrinsic(callData) : null;
};
