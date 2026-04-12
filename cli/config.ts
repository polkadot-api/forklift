import type { HexString } from "polkadot-api";
import { parse } from "yaml";

// ---------------------------------------------------------------------------
// Storage overrides
// ---------------------------------------------------------------------------

export type RawStorageOverride = {
  key: HexString;
  value: HexString | null;
};

export type DecodedStorageOverride = {
  pallet: string;
  entry: string;
  key?: unknown[];
  value: unknown | null;
};

export type StorageOverride = RawStorageOverride | DecodedStorageOverride;

export function isRawStorageOverride(
  o: StorageOverride
): o is RawStorageOverride {
  return "key" in o;
}

// ---------------------------------------------------------------------------
// Chain config
// ---------------------------------------------------------------------------

export type DelayModeConfig = "manual" | { timer: number };

export type ParsedChainConfig = {
  endpoint: string | string[];
  block?: number | string;
  port?: number;
  parachainOf?: string; // chain name of the relay chain this parachain belongs to
  options?: {
    disableOnIdle?: boolean;
    buildBlockMode?: DelayModeConfig;
    finalizeMode?: DelayModeConfig;
  };
  storage?: StorageOverride[];
};

// ---------------------------------------------------------------------------
// Top-level parsed config
// ---------------------------------------------------------------------------

export type ParsedSingleChainConfig = {
  type: "single";
  chain: ParsedChainConfig;
};

export type ParsedMultiChainConfig = {
  type: "multi";
  chains: Record<string, ParsedChainConfig>;
};

export type ParsedConfig = ParsedSingleChainConfig | ParsedMultiChainConfig;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function parseStorageEntry(entry: unknown, idx: number): StorageOverride {
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`storage[${idx}]: must be an object`);
  }

  if ("pallet" in entry && "entry" in entry) {
    const e = entry as Record<string, unknown>;
    if (typeof e.pallet !== "string")
      throw new Error(`storage[${idx}].pallet must be a string`);
    if (typeof e.entry !== "string")
      throw new Error(`storage[${idx}].entry must be a string`);
    if (!Array.isArray(e.key))
      throw new Error(`storage[${idx}].key must be an array`);
    return {
      pallet: e.pallet,
      entry: e.entry,
      key: e.key,
      value:
        JSON.parse(
          JSON.stringify(e.value),
          (_, value) => parseNumeric(value) ?? value
        ) ?? null,
    };
  } else if ("key" in entry) {
    const e = entry as Record<string, unknown>;
    if (typeof e.key !== "string" || !e.key.startsWith("0x")) {
      throw new Error(`storage[${idx}].key must be a 0x-prefixed hex string`);
    }
    if (
      e.value !== null &&
      e.value !== undefined &&
      (typeof e.value !== "string" || !(e.value as string).startsWith("0x"))
    ) {
      throw new Error(
        `storage[${idx}].value must be a 0x-prefixed hex string or null`
      );
    }
    return {
      key: e.key as HexString,
      value: (e.value ?? null) as HexString | null,
    };
  }

  throw new Error(
    `storage[${idx}]: must have either "key" (raw hex) or "pallet"+"storage" (decoded)`
  );
}

function validateDelayMode(raw: unknown, field: string): DelayModeConfig {
  if (raw === "manual") return "manual";
  if (
    typeof raw === "object" &&
    raw !== null &&
    "timer" in raw &&
    typeof (raw as Record<string, unknown>).timer === "number"
  ) {
    return raw as DelayModeConfig;
  }
  throw new Error(
    `${field}: expected "manual" or { timer: <ms> }, got ${JSON.stringify(raw)}`
  );
}

function parseChainConfig(raw: unknown, name: string): ParsedChainConfig {
  if (typeof raw !== "object" || raw === null)
    throw new Error(`Chain "${name}": must be an object`);
  const r = raw as Record<string, unknown>;

  if (r.endpoint === undefined)
    throw new Error(`Chain "${name}": missing "endpoint"`);
  if (
    typeof r.endpoint !== "string" &&
    !(
      Array.isArray(r.endpoint) &&
      r.endpoint.every((e) => typeof e === "string")
    )
  ) {
    throw new Error(
      `Chain "${name}": "endpoint" must be a string or array of strings`
    );
  }

  if (
    r.block !== undefined &&
    typeof r.block !== "number" &&
    typeof r.block !== "string"
  ) {
    throw new Error(`Chain "${name}": "block" must be a number or hex string`);
  }

  const parsedPort = r.port == null ? null : parseNumber(r.port as any);
  if (
    r.port != undefined &&
    (parsedPort == null || parsedPort < 1 || parsedPort > 65535)
  ) {
    throw new Error(
      `Chain "${name}": "port" must be an integer between 1 and 65535`
    );
  }

  const options: ParsedChainConfig["options"] = {};
  if (r.options !== undefined) {
    if (typeof r.options !== "object" || r.options === null)
      throw new Error(`Chain "${name}": "options" must be an object`);
    const o = r.options as Record<string, unknown>;
    if (o.disableOnIdle !== undefined)
      options.disableOnIdle = Boolean(o.disableOnIdle);
    if (o.buildBlockMode !== undefined)
      options.buildBlockMode = validateDelayMode(
        o.buildBlockMode,
        `${name}.options.buildBlockMode`
      );
    if (o.finalizeMode !== undefined)
      options.finalizeMode = validateDelayMode(
        o.finalizeMode,
        `${name}.options.finalizeMode`
      );
  }

  const storage: StorageOverride[] = [];
  if (r.storage !== undefined) {
    if (!Array.isArray(r.storage))
      throw new Error(`Chain "${name}": "storage" must be an array`);
    for (let i = 0; i < r.storage.length; i++)
      storage.push(parseStorageEntry(r.storage[i], i));
  }

  if (r.parachainOf !== undefined && typeof r.parachainOf !== "string")
    throw new Error(`Chain "${name}": "parachainOf" must be a string`);

  return {
    endpoint: r.endpoint as string | string[],
    block: parseNumber(r.block) ?? (r.block as number | string | undefined),
    port: parsedPort ?? undefined,
    ...(r.parachainOf !== undefined && {
      parachainOf: r.parachainOf as string,
    }),
    ...(Object.keys(options).length > 0 && { options }),
    ...(storage.length > 0 && { storage }),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseConfig(yaml: string): ParsedConfig {
  let raw: unknown;
  try {
    raw = parse(yaml);
  } catch (e) {
    throw new Error(`Failed to parse YAML: ${(e as Error).message}`);
  }

  if (typeof raw !== "object" || raw === null)
    throw new Error("Config must be a YAML object");
  const r = raw as Record<string, unknown>;

  if ("chains" in r) {
    if (
      typeof r.chains !== "object" ||
      r.chains === null ||
      Array.isArray(r.chains)
    ) {
      throw new Error('"chains" must be a map of chain name → chain config');
    }

    const chains: Record<string, ParsedChainConfig> = {};
    for (const [name, chainRaw] of Object.entries(r.chains as object)) {
      chains[name] = parseChainConfig(chainRaw, name);
    }

    for (const [name, chain] of Object.entries(chains)) {
      if (chain.parachainOf !== undefined && !(chain.parachainOf in chains))
        throw new Error(
          `Chain "${name}": parachainOf "${chain.parachainOf}" not found in chains`
        );
    }

    return { type: "multi", chains };
  }

  return { type: "single", chain: parseChainConfig(raw, "root") };
}

export async function loadConfig(path: string): Promise<ParsedConfig> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    throw new Error(`Cannot read config file: ${path}`);
  }
  return parseConfig(text);
}

const parseNumber = (value: unknown) => {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  value = value.replaceAll("_", "");
  return Number.isNaN(value) ? null : Number(value);
};

const parseNumeric = (value: unknown) => {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  if (value.endsWith("n")) {
    try {
      return BigInt(value.replaceAll("_", "").slice(0, -1));
    } catch {
      return null;
    }
  }
  value = value.replaceAll("_", "");
};
