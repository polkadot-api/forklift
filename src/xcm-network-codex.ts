import type { HexString } from "polkadot-api";
import type { Chain, NewBlockOptions } from "./chain";
import { getStorageCodecs } from "./codecs";
import {
  forklift,
  type Forklift,
  type ForkliftOptions,
  type ForkliftSource,
} from "./forklift";

type HrmpMessages = Record<number, unknown[]>;

export interface RelayParaNetworkConfig {
  relay: {
    source: ForkliftSource;
    options?: Partial<ForkliftOptions>;
  };
  para: {
    source: ForkliftSource;
    options?: Partial<ForkliftOptions>;
    paraId: number;
  };
}

export interface RelayParaNetwork {
  relay: Forklift;
  para: Forklift;
  stepRelay: (opts?: Partial<NewBlockOptions>) => Promise<HexString>;
  stepPara: (opts?: Partial<NewBlockOptions>) => Promise<HexString>;
  step: (opts?: {
    relay?: Partial<NewBlockOptions>;
    para?: Partial<NewBlockOptions>;
  }) => Promise<{ relay: HexString; para: HexString }>;
  destroy: () => void;
}

const extractMessageList = (queue: unknown): unknown[] => {
  if (Array.isArray(queue)) return queue;
  if (queue && typeof queue === "object") {
    const obj = queue as Record<string, unknown>;
    if (Array.isArray(obj.messages)) return obj.messages;
    if (Array.isArray(obj.queue)) return obj.queue;
  }
  return [];
};

const pickStorageCodec = async (
  block: Block,
  pallet: string,
  entries: string[]
) => {
  for (const entry of entries) {
    const codec = await getStorageCodecs(block, pallet, entry);
    if (codec) return codec;
  }
  return null;
};

const readRelayDmpMessages = async (
  chain: Chain,
  block: Block,
  paraId: number,
  cursor: Map<number, number>
) => {
  const codec = await pickStorageCodec(block, "Dmp", ["DownwardMessageQueues"]);
  if (!codec) return [];

  let decoded: unknown;
  try {
    const key = codec.keys.enc(paraId);
    const node = await chain.getStorage(block.hash, key);
    if (node.value == null) return [];
    decoded = codec.value.dec(node.value);
  } catch {
    const descendants = await chain.getStorageDescendants(
      block.hash,
      codec.keys.enc()
    );
    const match = Object.entries(descendants).find(([key, node]) => {
      if (node.value == null) return false;
      try {
        const [id] = codec.keys.dec(key);
        return Number(id) === paraId;
      } catch {
        return false;
      }
    });
    if (!match || match[1].value == null) return [];
    decoded = codec.value.dec(match[1].value);
  }

  const messages = extractMessageList(decoded);
  const start = cursor.get(paraId) ?? 0;
  cursor.set(paraId, messages.length);
  return messages.slice(start);
};

const readRelayHrmpMessages = async (
  chain: Chain,
  block: Block,
  paraId: number,
  cursor: Map<string, number>
) => {
  const codec = await pickStorageCodec(block, "Hrmp", ["HrmpChannelContents"]);
  if (!codec) return {};

  const descendants = await chain.getStorageDescendants(
    block.hash,
    codec.keys.enc()
  );
  const result: HrmpMessages = {};

  for (const [key, node] of Object.entries(descendants)) {
    if (node.value == null) continue;
    let sender: number;
    let recipient: number;
    try {
      const [senderId, recipientId] = codec.keys.dec(key);
      sender = Number(senderId);
      recipient = Number(recipientId);
    } catch {
      continue;
    }

    if (recipient !== paraId) continue;

    const decoded = codec.value.dec(node.value);
    const messages = extractMessageList(decoded);
    const channelKey = `${sender}:${recipient}`;
    const start = cursor.get(channelKey) ?? 0;
    cursor.set(channelKey, messages.length);
    const fresh = messages.slice(start);
    if (fresh.length) {
      result[sender] = fresh;
    }
  }

  return result;
};

const mergeHrmp = (base: HrmpMessages, incoming: HrmpMessages) => {
  const merged: HrmpMessages = { ...base };
  for (const [senderStr, messages] of Object.entries(incoming)) {
    const sender = Number(senderStr);
    merged[sender] = [...(merged[sender] ?? []), ...messages];
  }
  return merged;
};

export const createRelayParaNetwork = (
  config: RelayParaNetworkConfig
): RelayParaNetwork => {
  const relay = forklift(config.relay.source, config.relay.options);
  const para = forklift(config.para.source, config.para.options);
  const paraId = config.para.paraId;

  const inbound = { dmp: [] as unknown[], hrmp: {} as HrmpMessages };
  const dmpCursor = new Map<number, number>();
  const hrmpCursor = new Map<string, number>();

  const stepRelay = async (opts?: Partial<NewBlockOptions>) => {
    const hash = await relay.newBlock(opts);
    const block = relay.chain.getBlock(hash)!;

    const dmp = await readRelayDmpMessages(
      relay.chain,
      block,
      paraId,
      dmpCursor
    );
    if (dmp.length) inbound.dmp.push(...dmp);

    const hrmp = await readRelayHrmpMessages(
      relay.chain,
      block,
      paraId,
      hrmpCursor
    );
    if (Object.keys(hrmp).length) {
      inbound.hrmp = mergeHrmp(inbound.hrmp, hrmp);
    }

    return hash;
  };

  const stepPara = async (opts?: Partial<NewBlockOptions>) => {
    const dmp = [...inbound.dmp, ...(opts?.dmp ?? [])];
    const hrmp = mergeHrmp(inbound.hrmp, opts?.hrmp ?? {});

    const hash = await para.newBlock({
      ...opts,
      dmp,
      hrmp,
    });

    inbound.dmp = [];
    inbound.hrmp = {};

    return hash;
  };

  const step = async (opts?: {
    relay?: Partial<NewBlockOptions>;
    para?: Partial<NewBlockOptions>;
  }) => {
    const relayHash = await stepRelay(opts?.relay);
    const paraHash = await stepPara(opts?.para);
    return { relay: relayHash, para: paraHash };
  };

  return {
    relay,
    para,
    stepRelay,
    stepPara,
    step,
    destroy: () => {
      relay.destroy();
      para.destroy();
    },
  };
};
