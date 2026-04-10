import { relay } from "@polkadot-api/descriptors";
import {
  Binary,
  CompatibilityLevel,
  type HexString,
  type PolkadotClient,
} from "polkadot-api";
import { filter, firstValueFrom, map } from "rxjs";
import type { DmpMessage } from "./block-builder/create-block";
import type { Chain } from "./chain";
import { getConstant, getStorageCodecs } from "./codecs";
import { getNode, insertValue } from "./storage";

/**
 * Attaches the current forklift as a parachain to a forklift relay chain.
 */
export const attachRelay = async (
  relayClient: PolkadotClient,
  chain: Chain,
  xcm: {
    pushDmp: (messages: Array<DmpMessage>) => void;
  }
) => {
  const paraId: number | null = await getConstant(
    chain.getBlock(await firstValueFrom(chain.finalized$))!,
    "ParachainSystem",
    "SelfParaId"
  );
  if (paraId == null) {
    throw new Error("Could not get parachain ID");
  }

  const typedApi = relayClient.getTypedApi(relay);
  const staticApis = await typedApi.getStaticApis();
  if (
    !staticApis.compat.query.Dmp.DownwardMessageQueues.isCompatible(
      CompatibilityLevel.Partial
    )
  ) {
    throw new Error("Dmp queue incompatible");
  }

  console.log("watching dmp queue");
  let lastSentAt = 0;
  typedApi.query.Dmp.DownwardMessageQueues.watchValue(paraId)
    .pipe(
      map(({ block, value }) => ({
        block,
        messages: value.filter((v) => v.sent_at > lastSentAt),
      })),
      filter(({ messages }) => messages.length > 0)
    )
    .subscribe(({ block, messages }) => {
      relayClient._request("forklift_xcm_consume_dmp", [block.hash, paraId]);
      lastSentAt = messages
        .map((m) => m.sent_at)
        .reduce((a, b) => Math.max(a, b));

      console.log("push dmp", messages);
      xcm.pushDmp(messages);
    });
};

export const consumeDmp = async (
  chain: Chain,
  hash: HexString,
  paraId: number
) => {
  const blocks = await firstValueFrom(chain.blocks$);
  const targetBlock = blocks[hash];
  if (!targetBlock) {
    throw new Error("Block not found");
  }

  const codecs = await getStorageCodecs(
    targetBlock,
    "Dmp",
    "DownwardMessageQueues"
  );
  if (!codecs) {
    throw new Error("Dmp.DownwardMessageQueues not found");
  }

  const dmqKey = codecs.keys.enc(paraId);
  const dmqBinKey = Binary.fromHex(dmqKey);
  const targetDmqNode = await chain.getStorage(hash, dmqKey);
  const targetDmq: Array<DmpMessage> = targetDmqNode.value
    ? codecs.value.dec(targetDmqNode.value)
    : [];

  if (targetDmq.length === 0) return;

  const getDmpMessageKey = (msg: DmpMessage) =>
    `${msg.sent_at}_${Binary.toHex(msg.msg)}`;
  const targetDmqKeys = new Set(targetDmq.map(getDmpMessageKey));

  let blocksToUpdate = [hash];
  while (blocksToUpdate.length) {
    const hash = blocksToUpdate.pop()!;
    const block = blocks[hash]!;
    blocksToUpdate = [...block.children, ...blocksToUpdate];

    const childDmqNode = getNode(
      block.storageRoot,
      dmqBinKey,
      dmqBinKey.length * 2
    );

    const childDmq: Array<DmpMessage> = childDmqNode?.value
      ? codecs.value.dec(childDmqNode.value)
      : [];

    const newChildDmq = childDmq.filter(
      (v) => !targetDmqKeys.has(getDmpMessageKey(v))
    );

    block.storageRoot = insertValue(
      block.storageRoot,
      dmqBinKey,
      dmqBinKey.length * 2,
      codecs.value.enc(newChildDmq)
    );
  }

  console.log(
    `Cleared ${targetDmq.length} DMP messages for parachain ${paraId}`
  );
};
