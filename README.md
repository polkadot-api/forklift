# forklift

A tool for forking live Substrate/Polkadot-SDK chains locally, built natively on [polkadot-api](https://github.com/polkadot-api/polkadot-api).

Forklift is inspired by [@acala-network/chopsticks](https://github.com/AcalaNetwork/chopsticks), but it was built primarily for testing workflows that need multiple live branches of the chain, making it possible to simulate forks, reorgs, and pruned branches.

## Features

- Multiple live branches of the chain, including competing forks, reorgs, and pruned branches
- Immutable merkle-trie-backed storage with structural sharing between blocks
- Relay / parachain wiring helpers for local XCM testing
- Native `polkadot-api` implementation without `polkadot-js`
- Based on the new chainHead_v1 / archive_v1 JSON-RPC methods
- YAML-based CLI config for single-chain and multi-chain setups

## Installation

```sh
pnpm i @polkadot-api/forklift
```

Then run:

```sh
pnpm forklift --help
```

## CLI

Forklift can be started in two ways:

1. Directly from a remote endpoint
2. From a YAML config file

### Direct mode

```sh
forklift <url> [options]
```

Arguments:

| Argument | Description                       |
| -------- | --------------------------------- |
| `url`    | WebSocket URL of the node to fork |

Options:

| Option                    | Description                                                   | Default          |
| ------------------------- | ------------------------------------------------------------- | ---------------- |
| `-b, --block <block>`     | Block number or block hash to fork from                       | latest finalized |
| `-p, --port <port>`       | Preferred local WebSocket port                                | `3000`           |
| `-c, --config <file>`     | Load a YAML config instead of using direct mode               |                  |
| `-l, --log-level <level>` | Log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` | `info`           |

Examples:

```sh
# Fork the latest finalized block
forklift wss://rpc.polkadot.io

# Fork a specific block number
forklift wss://rpc.polkadot.io --block 22000000

# Fork a specific block hash
forklift wss://rpc.polkadot.io --block 0xabc123...

# Prefer a specific local port
forklift wss://rpc.polkadot.io --port 9000
```

The forklift CLI exposes a JSON-RPC WebSocket endpoint. In direct mode that is typically:

```txt
ws://localhost:3000
```

If the requested port is already in use, forklift will try the next free port.

## YAML Config

For anything beyond a single fork, the YAML config is the intended interface.

```sh
forklift --config forklift.yml
```

The config supports either:

- a single chain at the root level
- multiple named chains under `chains:`

### Single-chain config

```yaml
endpoint: wss://rpc.polkadot.io
block: 22000000
port: 3000
options:
  buildBlockMode:
    timer: 100
  finalizeMode:
    timer: 2000
storage:
  - key: 0x1234567890
    value: null
```

### Multi-chain config

```yaml
chains:
  relay:
    endpoint: wss://rpc.polkadot.io
    port: 3000

  assetHub:
    endpoint: wss://sys.ibp.network/asset-hub-polkadot
    port: 3001
    parachainOf: relay

  bridgeHub:
    endpoint: wss://sys.ibp.network/bridge-hub-polkadot
    port: 3002
    parachainOf: relay
```

In multi-chain mode:

- each entry under `chains:` starts its own local fork
- `parachainOf: <name>` declares that a chain should be attached to another local chain as its relay
- chains that share the same relay are also attached to each other as siblings

That makes the config suitable for relay/parachain and parachain/parachain XCM testing setups.

## Config Fields

Each chain config supports the following fields:

| Field         | Type     | Description                                     |
| ------------- | -------- | ----------------------------------------------- | --------------------------------------------------- |
| `endpoint`    | `string  | string[]`                                       | Remote WebSocket endpoint or endpoints to fork from |
| `block`       | `number  | string`                                         | Optional block number or block hash to fork from    |
| `port`        | `number` | Preferred local WebSocket port                  |
| `parachainOf` | `string` | Name of the relay chain in a multi-chain config |
| `options`     | `object` | Forklift runtime options                        |
| `storage`     | `array`  | Storage overrides applied after startup         |

### `options`

`options` maps closely to the programmatic `ForkliftOptions`.

```yaml
options:
  disableOnIdle: false
  buildBlockMode:
    timer: 100
  finalizeMode:
    timer: 2000
```

Supported values:

- `disableOnIdle: boolean`
  Disables `on_idle` hooks during block production. Some runtimes might perform actions that take a long time as they perform multiple serial storage queries. Setting this option to `true` disables that hook, which can increase the speed blocks can be produced.

- `buildBlockMode`
  Controls when new blocks are built after transactions arrive.

  Manual mode:

  ```yaml
  buildBlockMode: manual
  ```

  Timer mode:

  ```yaml
  buildBlockMode:
    timer: 100
  ```

- `finalizeMode`
  Controls when built blocks are finalized.

  Manual mode:

  ```yaml
  finalizeMode: manual
  ```

  Timer mode:

  ```yaml
  finalizeMode:
    timer: 2000
  ```

Notes:

- `manual` means forklift only changes state when you explicitly drive it
- `{ timer: 0 }` is allowed and means immediate scheduling
- if `port` is omitted, forklift will choose a free port automatically

## Storage Overrides

The `storage` section is applied after the local server has started and the initial block is available.

Forklift supports two storage override forms.

### Raw form

Use raw SCALE-encoded keys and values directly:

```yaml
storage:
  - key: 0x1234...
    value: 0xabcd...
  - key: 0x5678...
    value: null
```

Use `null` to delete or clear a storage entry.

### Decoded form

Use pallet / storage names and let the CLI encode the key and value from metadata:

```yaml
storage:
  - pallet: System
    entry: Account
    key:
      - 14GjNs7Lw7nVbJrL8aL8m8m4vY2mQ2L9mQf8u2YpK9nQx7aD
    value:
      providers: 1
      consumers: 0
      sufficients: 0
      data:
        free: 100_0_000_000_000n
        reserved: 0n
        frozen: 0n
        flags: 170141183460469231731687303715884105728n
```

Notes:

- `key` must be an array in decoded form, even if the storage entry takes a single key
- big integers can be written as strings ending in `n`, for example `1000000000000n`
- underscores are accepted in numeric strings for readability
- if a storage item, key, or value cannot be encoded against the chain metadata, forklift logs the error and skips that override

## Programmatic API

You can also create a chain from code:

```ts
import { forklift, wsSource } from "@polkadot-api/forklift";
import { Enum } from "polkadot-api";

const polkadot = forklift(
  wsSource("wss://rpc.polkadot.io", {
    atBlock: 22000000,
  }),
  {
    buildBlockMode: Enum("timer", 100),
    finalizeMode: Enum("timer", 2000),
    disableOnIdle: false,
  }
);
```

The forklift instance then has a property `serve` which is a `JsonRpcProvider` - This is [an unopinionated](https://papi.how/providers/enhancers#enhancers) interface that serves JSON-RPC connections, and can be plugged directly into polkadot-api:

```ts
import { forklift } from "@polkadot-api/forklift";
import { createClient } from "polkadot-api";

const polkadot = forklift(/* … */);
const client = createClient(polkadot.serve);
```

Or, given it's a simple interface, it's simple to expose that to a WS. For instance, using bun:

```ts
import { forklift } from "@polkadot-api/forklift";
const polkadot = forklift(/* … */);

Bun.serve({
  fetch(req, server) {
    // Al WS connections start with a HTTP request, we tell bun to upgrade the connection to a WS
    const success = server.upgrade(req, { data: {} });
    if (success) {
      return undefined;
    }

    // handle HTTP request normally
    return new Response("Nothing to see here, move along");
  },
  websocket: {
    data: {} as any,
    open(ws) {
      // When the WS opens we call the JsonRpcProvider to open a connection, and wire up incoming messages from forklift to send them out to the WS
      ws.data.connection = forklift.serve((msg) =>
        ws.send(JSON.stringify(msg))
      );
    },
    close(ws) {
      // When it closes we just close the connection
      ws.data.connection.disconnect();
    },
    async message(ws, message) {
      // When we receive a message we just pass it down to forklift
      ws.data.connection.send(JSON.parse(message as string));
    },
  },
});
```

### `Forklift` interface

```ts
interface Forklift {
  serve: JsonRpcProvider;

  newBlock(opts?: Partial<NewBlockOptions>): Promise<HexString>;
  changeBest(hash: HexString): Promise<void>;
  changeFinalized(hash: HexString): Promise<void>;
  setStorage(
    hash: HexString,
    changes: Record<string, Uint8Array>
  ): Promise<void>;
  getStorageDiff(
    hash: HexString,
    baseHash?: HexString
  ): Promise<
    Record<string, { value: Uint8Array | null; prev?: Uint8Array | null }>
  >;
  changeOptions(opts: Partial<ForkliftOptions>): void;
  destroy(): void;
}
```

### Block production modes

`buildBlockMode` controls when new blocks are produced:

- `Enum("manual")`: only explicit `newBlock()` calls produce blocks
- `Enum("timer", ms)`: automatically produce a block after a transaction arrives

`finalizeMode` controls when blocks are finalized:

- `Enum("manual")`: only explicit `changeFinalized()` calls finalize blocks
- `Enum("timer", ms)`: automatically finalize a block after it is built

### Producing forks

Pass a `parent` hash to branch from any existing block:

```ts
const base = await f.newBlock();

const forkA = await f.newBlock({ parent: base, type: "fork" });
const forkB = await f.newBlock({ parent: base, type: "fork" });
```

### Storage overrides from code

```ts
await f.setStorage(hash, {
  "0x...key": new Uint8Array([...value]),
});

const diff = await f.getStorageDiff(hash);
```

## JSON-RPC Surface

Forklift serves a WebSocket JSON-RPC endpoint and currently includes methods in these groups:

- `archive_v1_*`
- `chainHead_v1_*`
- `chainSpec_v1_*`
- `transaction_v1_*`
- `dev_*`
- `forklift_xcm_*`

## Acknowledgements

Forklift is heavily inspired by [@acala-network/chopsticks](https://github.com/AcalaNetwork/chopsticks) and reuses its WASM executor package, [`@acala-network/chopsticks-executor`](https://github.com/AcalaNetwork/chopsticks), for local runtime execution.
