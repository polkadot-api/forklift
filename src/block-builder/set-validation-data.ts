import { Binary } from "polkadot-api";
import type { Chain } from "../chain";
import {
  getCallData,
  getExtrinsicDecoder,
  getTxCodec,
  unsignedExtrinsic,
} from "../codecs";
import type { Block } from "./create-block";

export const setValidationDataInherent = async (
  chain: Chain,
  parentBlock: Block
) => {
  const txCodec = getTxCodec(
    parentBlock,
    "ParachainSystem",
    "set_validation_data"
  );
  if (!txCodec) return null;

  const txDec = getExtrinsicDecoder(parentBlock);
  const prevValidationDataRaw = parentBlock.body.find((raw) => {
    const ext = txDec(raw);
    return (
      ext.call.type === "ParachainSystem" &&
      ext.call.value.type === "set_validation_data"
    );
  });
  const prevValidationDataExt =
    prevValidationDataRaw && txDec(prevValidationDataRaw);
  const prevValidationData = prevValidationDataExt?.call.value.value.data;

  if (!prevValidationData) {
    throw new Error("TODO no prevValidationData in previous block");
  }

  const data = {
    ...prevValidationData,
    validation_data: {
      ...prevValidationData.validation_data,
      relay_parent_number:
        prevValidationData.validation_data.relay_parent_number + 1,
    },
  };

  const inbound_messages_data = {
    downward_messages: {
      full_messages: [],
      hashed_messages: [],
    },
    horizontal_messages: {
      full_messages: [],
      hashed_messages: [],
    },
  };

  return unsignedExtrinsic(
    getCallData(parentBlock, "ParachainSystem", "set_validation_data", {
      data,
      inbound_messages_data,
    })!
  );
};
