import {
  getDynamicBuilder,
  getLookupFn,
} from "@polkadot-api/metadata-builders";
import {
  decAnyMetadata,
  unifyMetadata,
} from "@polkadot-api/substrate-bindings";
import {
  createClient as createRawClient,
  type SubstrateClient,
} from "@polkadot-api/substrate-client";
import { Binary, Enum, type HexString } from "polkadot-api";
import { createWsClient, getWsRawProvider } from "polkadot-api/ws";
import { forklift } from "../src";
import { createWsServer } from "../server/node";
import type {
  ParsedChainConfig,
  ParsedConfig,
  RawStorageOverride,
} from "./config";
import { log } from "./log";

export const runFromConfig = async (config: ParsedConfig) => {
  const chains =
    config.type === "single"
      ? {
          single: config.chain,
        }
      : config.chains;

  const ports = await Promise.all(
    Object.entries(chains).map(([key, chain]) =>
      startChain(chain, config.type === "single" ? undefined : key)
    )
  );

  if (config.type === "multi") {
    const chainToPort: Record<string, number> = Object.fromEntries(ports);

    // Group parachains by relay
    const parasByRelay = new Map<string, string[]>();
    for (const [name, chain] of Object.entries(config.chains)) {
      const relay = chain.parachainOf;
      if (!relay) continue;
      const list = parasByRelay.get(relay) ?? [];
      list.push(name);
      parasByRelay.set(relay, list);
    }

    // Attach each parachain to its relay
    for (const [name, chain] of Object.entries(config.chains)) {
      const relay = chain.parachainOf;
      if (!relay) continue;
      log.info(`Attaching ${name} as parachain to ${relay}`);
      const client = createRawClient(
        getWsRawProvider(`ws://localhost:${chainToPort[name]}`)
      );
      await rawClientRequest(client, "forklift_xcm_attach_relay", [
        `ws://localhost:${chainToPort[relay]}`,
      ]);
      client.destroy();
    }

    // Attach siblings (all pairs sharing the same relay)
    for (const paras of parasByRelay.values()) {
      for (const a of paras) {
        for (const b of paras) {
          if (b <= a) continue; // process each pair once
          log.info(`Attaching ${a} and ${b} as siblings`);
          const client = createRawClient(
            getWsRawProvider(`ws://localhost:${chainToPort[a]}`)
          );
          await rawClientRequest(client, "forklift_xcm_attach_sibling", [
            `ws://localhost:${chainToPort[b]}`,
          ]);
          client.destroy();
        }
      }
    }
  }
};

const rawClientRequest = (
  client: SubstrateClient,
  method: string,
  params: unknown[]
) =>
  new Promise((resolve, reject) =>
    client._request(method, params, {
      onSuccess: resolve,
      onError: reject,
    })
  );

const startChain = async (config: ParsedChainConfig, key?: string) => {
  const logWithKey = log ? log.child({ chain: key }) : log;
  logWithKey.info(
    `Forking ${config.endpoint}${
      config.block !== undefined ? ` at block ${config.block}` : ""
    }`
  );

  const f = forklift(
    {
      type: "remote",
      value: { url: config.endpoint, atBlock: config.block },
    },
    {
      buildBlockMode:
        config.options?.buildBlockMode &&
        (typeof config.options.buildBlockMode === "string"
          ? Enum("manual")
          : Enum("timer", config.options.buildBlockMode.timer)),
      finalizeMode:
        config.options?.finalizeMode &&
        (typeof config.options.finalizeMode === "string"
          ? Enum("manual")
          : Enum("timer", config.options.finalizeMode.timer)),
      disableOnIdle: config.options?.disableOnIdle,
      mockSignatureHost: config.options?.mockSignatureHost,
    }
  );

  const server = await createWsServer(f, { port: config.port });

  if (config.storage) {
    logWithKey.info(`Waiting for initial block`);
    const client = createWsClient(`ws://localhost:${server.port}`);
    const finalized = await client.getFinalizedBlock();

    logWithKey.info(`Overriding storage`);
    const metadata = await client.getMetadata(finalized.hash);
    const dynamicBuilder = getDynamicBuilder(
      getLookupFn(unifyMetadata(decAnyMetadata(metadata)))
    );

    const rawOverrides = await Promise.all(
      config.storage.map(
        async (override): Promise<RawStorageOverride | null> => {
          if ("pallet" in override) {
            const codecs = dynamicBuilder.buildStorage(
              override.pallet,
              override.entry
            );
            if (!codecs) {
              logWithKey.error(
                `Storage entry ${override.pallet}.${override.entry} not found, skipping`
              );
              return null;
            }
            let key: HexString = "";
            let value: HexString | null = null;
            try {
              key = codecs.keys.enc(...(override.key ?? []));
            } catch {
              logWithKey.error(
                `Storage key ${override.pallet}.${override.entry} not compatible, skipping`
              );
              return null;
            }
            try {
              value =
                override.value == null
                  ? null
                  : Binary.toHex(codecs.value.enc(override.value));
            } catch {
              logWithKey.error(
                `Storage value ${override.pallet}.${override.entry} not compatible, skipping`
              );
              return null;
            }
            return {
              key,
              value,
            };
          } else {
            return override;
          }
        }
      )
    );
    await client._request("dev_setStorage", [
      rawOverrides
        .filter((v) => v != null)
        .map((override) => [override.key, override.value]),
    ]);
    client.destroy();
  }
  logWithKey.info(
    `${key ? key + " " : ""}listening on ws://localhost:${
      server.port
    } https://dev.papi.how/storage#networkId=localhost&endpoint=ws%3A%2F%2F127.0.0.1%3A${
      server.port
    }`
  );

  return [key, server.port!] as const;
};
