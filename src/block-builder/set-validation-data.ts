import { create_proof, decode_proof } from "@acala-network/chopsticks-executor";
import {
  Blake2256,
  Bytes,
  Option,
  Struct,
  Twox128,
  Twox64Concat,
  Vector,
  blockHeader,
  compact,
  u32,
  u64,
} from "@polkadot-api/substrate-bindings";
import { Binary, type HexString } from "polkadot-api";
import { mergeUint8 } from "polkadot-api/utils";
import type { Chain } from "../chain";
import {
  getCallData,
  getConstant,
  getExtrinsicDecoder,
  getTxCodec,
  unsignedExtrinsic,
} from "../codecs";
import type { Block, XcmMessages } from "./create-block";
import {
  getCurrentSlot,
  getSlotDuration,
  runtimeBlockHeader,
  type RuntimeBlockHeader,
} from "./slot-utils";

const textEncoder = new TextEncoder();
const RELAY_CHAIN_SLOT_DURATION_MILLIS = 6_000n;

// Compute a Substrate storage key: twox128(pallet) ++ twox128(storage)
const storagePrefix = (pallet: string, storage: string): HexString =>
  Binary.toHex(
    mergeUint8([
      Twox128(textEncoder.encode(pallet)),
      Twox128(textEncoder.encode(storage)),
    ])
  ) as HexString;

const DMP_QUEUE_HEADS_KEY = storagePrefix("Dmp", "DownwardMessageQueueHeads");
const HRMP_INGRESS_INDEX_KEY = storagePrefix(
  "Hrmp",
  "HrmpIngressChannelsIndex"
);
const HRMP_EGRESS_INDEX_KEY = storagePrefix("Hrmp", "HrmpEgressChannelsIndex");
const HRMP_CHANNELS_KEY = storagePrefix("Hrmp", "HrmpChannels");

const appendParaId = (key: HexString, paraId: number) =>
  Binary.toHex(
    mergeUint8([Binary.fromHex(key), Twox64Concat(u32.enc(paraId))])
  ) as HexString;

const hrmpIngressIndexKey = (receiverParaId: number): HexString =>
  appendParaId(HRMP_INGRESS_INDEX_KEY, receiverParaId);

const hrmpEgressIndexKey = (senderParaId: number): HexString =>
  appendParaId(HRMP_EGRESS_INDEX_KEY, senderParaId);

const hrmpChannelKey = (sender: number, receiver: number): HexString =>
  Binary.toHex(
    mergeUint8([
      Binary.fromHex(HRMP_CHANNELS_KEY),
      Twox64Concat(mergeUint8([u32.enc(sender), u32.enc(receiver)])),
    ])
  ) as HexString;

const DEFAULT_CHANNEL = {
  max_capacity: 1000,
  max_total_size: 102400,
  max_message_size: 102400,
  msg_count: 0,
  total_size: 0,
  mqc_head: undefined as Uint8Array | undefined,
};

const BABE_CURRENT_SLOT_KEY = storagePrefix("Babe", "CurrentSlot");

// Well-known relay chain storage keys that must be preserved in the proof.
// These are required for the parachain runtime to verify relay chain state.
// Keys are computed from pallet/storage names per Substrate storage conventions.
const PRESERVE_PROOFS = [
  storagePrefix("Babe", "EpochIndex"),
  storagePrefix("Babe", "CurrentBlockRandomness"),
  storagePrefix("Babe", "Randomness"),
  storagePrefix("Babe", "NextRandomness"),
  BABE_CURRENT_SLOT_KEY,
  storagePrefix("Configuration", "ActiveConfig"),
  storagePrefix("Babe", "Authorities"),
];

// Storage key prefix for Paras::Heads(paraId) on the relay chain
const PARAS_HEADS_PREFIX = Binary.fromHex(storagePrefix("Paras", "Heads"));

// Compute the full storage key: prefix ++ twox64Concat(paraId)
const paraHeadKey = (paraId: number): Uint8Array => {
  const paraIdBytes = u32.enc(paraId);
  return mergeUint8([PARAS_HEADS_PREFIX, Twox64Concat(paraIdBytes)]);
};

// Encode HeadData (Vec<u8> wrapper around encoded header)
const encodeHeadData = (header: Uint8Array): Uint8Array => {
  return mergeUint8([compact.enc(header.length), header]);
};

export const setValidationDataInherent = async (
  chain: Chain,
  parentBlock: Block,
  xcm: XcmMessages
) => {
  if (
    !parentBlock.header.digests.some(
      (d) => d.type === "preRuntime" && d.value.engine === "aura"
    )
  )
    return null;

  const txCodec = getTxCodec(
    parentBlock,
    "ParachainSystem",
    "set_validation_data"
  );
  if (!txCodec) return null;

  const txDec = await getExtrinsicDecoder(parentBlock);
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

  // Get parachain ID from runtime constant
  const paraId: number | null = await getConstant(
    parentBlock,
    "ParachainSystem",
    "SelfParaId"
  );
  if (paraId == null) {
    throw new Error("Could not get parachain ID");
  }

  // Encode the parent block header as HeadData to inject into relay chain proof
  const encodedParentHeader = blockHeader.enc(parentBlock.header);
  const headData = encodeHeadData(encodedParentHeader);
  const storageKey = paraHeadKey(paraId);

  // Get the existing relay chain state proof
  const existingNodes = (
    prevValidationData.relay_chain_state as Uint8Array[]
  ).map((node) => Binary.toHex(node));
  const existingStateRoot =
    prevValidationData.validation_data.relay_parent_storage_root;

  // Decode the existing proof to extract current values
  // Returns array of [key, value] pairs
  const decodedProofArray = (await decode_proof(
    existingStateRoot,
    existingNodes
  )) as [HexString, HexString | null][];

  // Convert to a Map for easy lookup
  const decodedProof = new Map(decodedProofArray);

  const slotDuration = await getSlotDuration(chain, parentBlock);
  const relaySlotIncreaseRaw = slotDuration / RELAY_CHAIN_SLOT_DURATION_MILLIS;
  const relaySlotIncrease =
    relaySlotIncreaseRaw > 0n ? relaySlotIncreaseRaw : 1n;

  const relayCurrentSlot = await (async () => {
    const currentSlotHex = decodedProof.get(BABE_CURRENT_SLOT_KEY);
    if (typeof currentSlotHex === "string") {
      return u64.dec(Binary.fromHex(currentSlotHex));
    }

    const currentSlot = await getCurrentSlot(chain, parentBlock);
    return currentSlot * relaySlotIncrease;
  })();

  const nextRelayChainSlot = Binary.toHex(
    u64.enc(relayCurrentSlot + relaySlotIncrease)
  ) as HexString;

  // Build new entries: preserve all PRESERVE_PROOFS + add paraHead
  const newEntries: [HexString, HexString | null][] = [];

  // Preserve all well-known relay chain storage entries (including AUTHORITIES)
  for (const key of PRESERVE_PROOFS) {
    if (decodedProof.has(key)) {
      const value =
        key === BABE_CURRENT_SLOT_KEY && nextRelayChainSlot
          ? nextRelayChainSlot
          : decodedProof.get(key) ?? null;
      newEntries.push([key as HexString, value]);
    }
  }

  // Add the parachain head entry (this signals inclusion of parent block)
  newEntries.push([
    Binary.toHex(storageKey) as HexString,
    Binary.toHex(headData) as HexString,
  ]);

  const dmpHashKey = appendParaId(DMP_QUEUE_HEADS_KEY, paraId);
  let dmpHash = Binary.fromHex(
    decodedProof.get(dmpHashKey) ??
      "0x0000000000000000000000000000000000000000000000000000000000000000"
  );
  for (const { msg, sent_at } of xcm.dmp) {
    dmpHash = Blake2256(
      mqcChain.enc({
        hash: dmpHash,
        sent_at,
        msg_hash: Blake2256(Binary.toOpaque(msg)),
      })
    );
  }
  newEntries.push([dmpHashKey, Binary.toHex(dmpHash)]);

  // Preserve existing HRMP egress channel entries from the original proof, and inject
  // any manually registered channels. The runtime checks these to know which outbound
  // channels are open before queuing messages.
  const egressIndexHex = decodedProof.get(hrmpEgressIndexKey(paraId));
  const existingEgressRecipients = egressIndexHex
    ? vecU32.dec(Binary.fromHex(egressIndexHex))
    : [];
  const allEgressRecipients = [
    ...new Set([...existingEgressRecipients, ...chain.hrmpChannels]),
  ].sort((a, b) => a - b);

  if (allEgressRecipients.length > 0) {
    newEntries.push([
      hrmpEgressIndexKey(paraId),
      Binary.toHex(vecU32.enc(allEgressRecipients)),
    ]);

    for (const recipientId of allEgressRecipients) {
      const chKey = hrmpChannelKey(paraId, recipientId);

      const existingHex = decodedProof.get(chKey);
      if (existingHex) {
        newEntries.push([chKey, existingHex]);
      } else {
        newEntries.push([
          chKey,
          Binary.toHex(AbridgedHrmpChannelCodec.enc(DEFAULT_CHANNEL)),
        ]);
      }
    }
  }

  const nextRelayNumber =
    Number(prevValidationData.validation_data.relay_parent_number) +
    Number(relaySlotIncrease);

  const ingressIndexHex = decodedProof.get(hrmpIngressIndexKey(paraId));
  const existingIngressRecipients = ingressIndexHex
    ? vecU32.dec(Binary.fromHex(ingressIndexHex))
    : [];
  const allIngressSenders = [
    ...new Set([...existingIngressRecipients, ...chain.hrmpChannels]),
  ].sort((a, b) => a - b);

  if (allIngressSenders.length > 0)
    newEntries.push([
      hrmpIngressIndexKey(paraId),
      Binary.toHex(vecU32.enc(allIngressSenders)),
    ]);

  // Update HrmpChannels for each sender: compute new MQC head
  for (const senderId of allIngressSenders) {
    const chKey = hrmpChannelKey(senderId, paraId);
    const existingHex = decodedProof.get(chKey);
    const ch = existingHex
      ? AbridgedHrmpChannelCodec.dec(existingHex)
      : { ...DEFAULT_CHANNEL };

    const hrmpMessages = xcm.hrmp[senderId];

    if (hrmpMessages) {
      let mqcHead = ch.mqc_head ?? new Uint8Array(32);
      let totalSize = ch.total_size;
      for (const data of hrmpMessages) {
        mqcHead = Blake2256(
          mqcChain.enc({
            hash: mqcHead,
            sent_at: nextRelayNumber,
            msg_hash: Blake2256(Binary.toOpaque(data)),
          })
        );
        totalSize += data.length;
      }
      newEntries.push([
        chKey,
        Binary.toHex(
          AbridgedHrmpChannelCodec.enc({
            ...ch,
            msg_count: ch.msg_count + hrmpMessages.length,
            total_size: totalSize,
            mqc_head: mqcHead,
          })
        ),
      ]);
    } else {
      newEntries.push([chKey, Binary.toHex(AbridgedHrmpChannelCodec.enc(ch))]);
    }
  }

  // Create updated proof with all entries
  const [newStateRoot, newNodes]: [HexString, HexString[]] = await create_proof(
    existingNodes,
    newEntries
  );

  // Keep relay_parent_descendants aligned with the new relay parent number.
  const originalDescendants: Array<RuntimeBlockHeader> =
    prevValidationData.relay_parent_descendants ?? [];

  // Update relay_parent_descendants:
  // 1. First descendant's state_root must match our new relay_parent_storage_root
  // 2. Each subsequent descendant's parentHash must be the hash of the previous header
  const updatedDescendants: Array<RuntimeBlockHeader> = [];
  let lastHeaderHash: HexString | undefined;
  let nextDescNumber =
    Number(prevValidationData.validation_data.relay_parent_number) +
    Number(relaySlotIncrease);

  for (let i = 0; i < originalDescendants.length; i++) {
    const desc = originalDescendants[i]!;

    // Build updated header
    const updatedDesc = {
      ...desc,
      // Update state_root for the first descendant
      state_root: i === 0 ? newStateRoot : desc.state_root,
      // Update parentHash to point to the modified previous header
      parent_hash: lastHeaderHash ?? desc.parent_hash,
      // Align descendant numbers with the new relay_parent_number
      number: nextDescNumber,
    };

    updatedDescendants.push(updatedDesc);
    nextDescNumber += 1;

    const encoded = runtimeBlockHeader.enc(updatedDesc);
    lastHeaderHash = Binary.toHex(Blake2256(encoded));
  }

  const data = {
    ...prevValidationData,
    validation_data: {
      ...prevValidationData.validation_data,
      relay_parent_number: nextRelayNumber,
      relay_parent_storage_root: newStateRoot,
    },
    relay_chain_state: newNodes.map((node) => Binary.fromHex(node)),
    relay_parent_descendants: updatedDescendants,
  };

  const inbound_messages_data = {
    downward_messages: {
      full_messages: xcm.dmp,
      hashed_messages: [],
    },
    horizontal_messages: {
      full_messages: allIngressSenders.flatMap((senderId) =>
        (xcm.hrmp[senderId] ?? []).map((data) => [
          senderId,
          {
            sent_at: nextRelayNumber,
            data,
          },
        ])
      ),
      hashed_messages: [],
    },
  };

  const callData = await getCallData(
    parentBlock,
    "ParachainSystem",
    "set_validation_data",
    {
      data,
      inbound_messages_data,
    }
  );
  return unsignedExtrinsic(callData!);
};

const mqcChain = Struct({
  hash: Bytes(32),
  sent_at: u32,
  msg_hash: Bytes(32),
});

const vecU32 = Vector(u32);
const AbridgedHrmpChannelCodec = Struct({
  max_capacity: u32,
  max_total_size: u32,
  max_message_size: u32,
  msg_count: u32,
  total_size: u32,
  mqc_head: Option(Bytes(32)),
});
