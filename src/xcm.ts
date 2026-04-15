import { parachain, relay } from "../.papi/descriptors/dist";
import { concatMapEager } from "@polkadot-api/observable-client";
import {
  bool,
  Bytes,
  Struct,
  Tuple,
  u32,
} from "@polkadot-api/substrate-bindings";
import {
  Binary,
  CompatibilityLevel,
  Enum,
  type HexString,
  type PolkadotClient,
} from "polkadot-api";
import { catchError, filter, firstValueFrom, from, map } from "rxjs";
import type { DmpMessage } from "./block-builder/create-block";
import type { Chain } from "./chain";
import { getConstant, getStorageCodecs } from "./codecs";
import { getNode, insertValue } from "./storage";
import { logger } from "./logger";

const log = logger.child({ module: "xcm" });

/**
 * Attaches the current forklift as a parachain to a forklift relay chain.
 */
export const attachRelay = async (
  relayClient: PolkadotClient,
  parachainClient: PolkadotClient,
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

  const parachainApi = parachainClient.getTypedApi(parachain);
  if (
    !(
      await parachainApi.getStaticApis()
    ).compat.query.ParachainSystem.UpwardMessages.isCompatible(
      CompatibilityLevel.Partial
    )
  ) {
    throw new Error("UpwardMessageQueue incompatible");
  }

  log.debug("watching dmp queue");
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

      xcm.pushDmp(messages);
    });

  log.debug("watching ump queue");
  parachainClient.finalizedBlock$
    .pipe(
      concatMapEager((block) =>
        from(
          parachainApi.query.ParachainSystem.UpwardMessages.getValue({
            at: block.hash,
          })
        ).pipe(
          catchError((ex) => {
            log.error(ex, "error reading upward messages");
            return [];
          })
        )
      )
    )
    .subscribe((messages) => {
      relayClient._request("forklift_xcm_push_ump", [
        paraId,
        messages.map(Binary.toHex),
      ]);
    });
};

/**
 * Consume DMP messages for a specific parachain.
 *
 * As we don't have a real ParaInherent.enter inherent, we need to clear them manually.
 * Here we mutate the state of the target block and descendants to remove the messages.
 * Another option would be to keep the messages in a "blacklist" so that the queue is cleared out
 * when building a new block, but knowing when to clear the blacklist is not trivial.
 */
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

    // If it doesn't have a value in the local node, it means it had the same value as all of its parents.
    // And one of those parents is the target that we're removing all the dmq messages from,
    // which means will end up in `[]` anyway
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

  log.info({ paraId, count: targetDmq.length }, "cleared DMP messages");
};

export const pushUmp = async (
  chain: Chain,
  paraId: number,
  messages: Array<Uint8Array>
) => {
  if (messages.length === 0) return;

  const finalizedHash = await firstValueFrom(chain.finalized$);
  const blocks = await firstValueFrom(chain.blocks$);
  const finalizedBlock = blocks[finalizedHash];
  if (!finalizedBlock) throw new Error(" lock not found");

  const [pageCodecs, bookCodecs, serviceHeadCodecs] = await Promise.all([
    getStorageCodecs(finalizedBlock, "MessageQueue", "Pages"),
    getStorageCodecs(finalizedBlock, "MessageQueue", "BookStateFor"),
    getStorageCodecs(finalizedBlock, "MessageQueue", "ServiceHead"),
  ]);
  if (!(serviceHeadCodecs && bookCodecs && pageCodecs))
    throw new Error("MessageQueue codecs not found");

  const totalMsgSize = messages.reduce((acc, p) => acc + p.length, 0);
  const lastOffset = messages
    .slice(0, -1)
    .reduce((acc, msg) => acc + 5 + msg.length, 0);
  const heap = heapEncoder(messages);

  const origin = Enum("Ump", Enum("Para", paraId));
  const bookBinKey = Binary.fromHex(bookCodecs.keys.enc(origin));
  const serviceHeadBinKey = Binary.fromHex(serviceHeadCodecs.keys.enc());

  // Apply updates to finalized block and all its descendants.
  // For each block, read the local trie state (via getNode) so that we append to whatever
  // messages are already there rather than overwriting them.
  let blocksToUpdate = [finalizedHash];
  while (blocksToUpdate.length) {
    const hash = blocksToUpdate.pop()!;
    const block = blocks[hash]!;
    blocksToUpdate = [...block.children, ...blocksToUpdate];

    const existingBookNode = getNode(
      block.storageRoot,
      bookBinKey,
      bookBinKey.length * 2
    );
    const existingBook = existingBookNode?.value
      ? bookCodecs.value.dec(existingBookNode.value)
      : null;

    const wasEmpty = !existingBook || existingBook.begin === existingBook.end;
    const pageIndex: number = existingBook ? existingBook.end : 0;
    const pageBinKey = Binary.fromHex(pageCodecs.keys.enc(origin, pageIndex));

    const newBook = {
      begin: existingBook?.begin ?? 0,
      end: pageIndex + 1,
      count: (existingBook?.count ?? 0) + 1,
      ready_neighbours: existingBook?.ready_neighbours ?? undefined,
      message_count:
        (existingBook?.message_count ?? 0n) + BigInt(messages.length),
      size: (existingBook?.size ?? 0n) + BigInt(totalMsgSize),
    };

    const page = {
      remaining: messages.length,
      remaining_size: totalMsgSize,
      first_index: 0,
      first: 0,
      last: lastOffset,
      heap,
    };

    block.storageRoot = insertValue(
      block.storageRoot,
      pageBinKey,
      pageBinKey.length * 2,
      pageCodecs.value.enc(page)
    );

    // If the book was empty, jump the queue by making origin the new ServiceHead.
    if (wasEmpty) {
      const serviceHeadNode = getNode(
        block.storageRoot,
        serviceHeadBinKey,
        serviceHeadBinKey.length * 2
      );
      const existingServiceHead = serviceHeadNode?.value
        ? serviceHeadCodecs.value.dec(serviceHeadNode.value)
        : null;

      if (existingServiceHead) {
        // Point origin forward into the existing ring, and fix the old head's prev pointer
        newBook.ready_neighbours = { prev: origin, next: existingServiceHead };
        const existingHeadBookBinKey = Binary.fromHex(
          bookCodecs.keys.enc(existingServiceHead)
        );
        const existingHeadBookNode = getNode(
          block.storageRoot,
          existingHeadBookBinKey,
          existingHeadBookBinKey.length * 2
        );
        const existingHeadBook = existingHeadBookNode?.value
          ? bookCodecs.value.dec(existingHeadBookNode.value)
          : null;
        if (existingHeadBook?.ready_neighbours) {
          existingHeadBook.ready_neighbours.prev = origin;
          block.storageRoot = insertValue(
            block.storageRoot,
            existingHeadBookBinKey,
            existingHeadBookBinKey.length * 2,
            bookCodecs.value.enc(existingHeadBook)
          );
        }
      } else {
        newBook.ready_neighbours = { prev: origin, next: origin };
      }

      block.storageRoot = insertValue(
        block.storageRoot,
        serviceHeadBinKey,
        serviceHeadBinKey.length * 2,
        serviceHeadCodecs.value.enc(origin)
      );
    }

    block.storageRoot = insertValue(
      block.storageRoot,
      bookBinKey,
      bookBinKey.length * 2,
      bookCodecs.value.enc(newBook)
    );
  }
};

/**
 * Attaches two sibling parachains for bidirectional HRMP message passing.
 * Called on self (Para A) with the sibling's (Para B) URL.
 * Sets up:
 *  - Sibling → Self: watch Para B's HrmpOutboundMessages, push to self via xcm.pushHrmp
 *  - Self → Sibling: watch Para A's HrmpOutboundMessages, push to Para B via forklift_xcm_push_hrmp
 */
export const attachSibling = async (
  siblingClient: PolkadotClient,
  selfClient: PolkadotClient,
  chain: Chain,
  xcm: { pushHrmp: (senderId: number, messages: Uint8Array[]) => void }
) => {
  const selfParaId: number | null = await getConstant(
    chain.getBlock(await firstValueFrom(chain.finalized$))!,
    "ParachainSystem",
    "SelfParaId"
  );
  if (selfParaId == null) throw new Error("Could not get self parachain ID");

  const siblingApi = siblingClient.getTypedApi(parachain);
  const selfApi = selfClient.getTypedApi(parachain);

  const staticApis = await siblingApi.getStaticApis();
  if (
    !staticApis.compat.query.ParachainSystem.HrmpOutboundMessages.isCompatible(
      CompatibilityLevel.Partial
    )
  ) {
    throw new Error("HrmpOutboundMessages incompatible");
  }

  const siblingParaId: number =
    await siblingApi.constants.ParachainSystem.SelfParaId();
  log.info({ selfParaId, siblingParaId }, "attaching HRMP channel");

  // Open egress channels on both sides so each chain's relay proof includes the channel.
  chain.openHrmpChannel(siblingParaId);
  siblingClient._request("forklift_xcm_open_hrmp_channel", [selfParaId]);

  // Sibling → Self: watch Para B outbound, push messages destined for self
  siblingClient.finalizedBlock$
    .pipe(
      concatMapEager((block) =>
        from(
          siblingApi.query.ParachainSystem.HrmpOutboundMessages.getValue({
            at: block.hash,
          })
        ).pipe(
          catchError((ex) => {
            log.error(ex, "error reading sibling HRMP outbound messages");
            return [];
          })
        )
      )
    )
    .subscribe((messages) => {
      const forSelf = messages.filter((m) => m.recipient === selfParaId);
      if (forSelf.length > 0) {
        xcm.pushHrmp(
          siblingParaId,
          forSelf.map((m) => m.data)
        );
      }
    });

  // Self → Sibling: watch Para A outbound, push messages destined for sibling
  selfClient.finalizedBlock$
    .pipe(
      concatMapEager((block) =>
        from(
          selfApi.query.ParachainSystem.HrmpOutboundMessages.getValue({
            at: block.hash,
          })
        ).pipe(
          catchError((ex) => {
            log.error(ex, "error reading self HRMP outbound messages");
            return [];
          })
        )
      )
    )
    .subscribe((messages) => {
      const forSibling = messages.filter((m) => m.recipient === siblingParaId);
      if (forSibling.length > 0) {
        siblingClient._request("forklift_xcm_push_hrmp", [
          selfParaId,
          forSibling.map((m) => Binary.toHex(m.data)),
        ]);
      }
    });
};

const heapEncoder = (value: Uint8Array[]) =>
  Tuple(
    ...value.map((coded) =>
      Struct({
        length: u32,
        is_processed: bool,
        payload: Bytes(coded.length),
      })
    )
  ).enc(
    value.map((payload) => ({
      length: payload.length,
      is_processed: false,
      payload,
    }))
  );
