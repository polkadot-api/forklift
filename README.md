# forklift

> **Early prototype** — Still missing many features

A tool for forking live Substrate/Polkadot-SDK chains locally, built natively on [polkadot-api](https://github.com/polkadot-api/polkadot-api). Inspired by [@acala-network/chopsticks](https://github.com/AcalaNetwork/chopsticks), but with the primary motivation of enabling integration tests that require **multiple concurrent forks** of the same chain.

## Features

- **Multiple forks** — maintain several independent chain heads simultaneously
- **Merkle trie storage** — each block's state is an immutable 16-way radix trie with structural sharing, enabling efficient forking and merkle proof generation without duplicating data
- **polkadot-api native** — built entirely on polkadot-api, no polkadot-js dependency
- **New JSON-RPC spec** — uses only the new archive/chainHead RPC methods

## Installation

Requires [Bun](https://bun.sh).

```sh
bun install
```

To install the CLI globally:

```sh
bun link
```

## CLI

```
forklift <url> [options]
```

**Arguments:**

| Argument | Description                       |
| -------- | --------------------------------- |
| `url`    | WebSocket URL of the node to fork |

**Options:**

| Option                | Description                       | Default          |
| --------------------- | --------------------------------- | ---------------- |
| `-b, --block <block>` | Block number or hash to fork from | latest finalized |
| `-p, --port <port>`   | Port to listen on                 | `3000`           |

**Examples:**

```sh
# Fork the latest finalized block
forklift wss://rpc.polkadot.io

# Fork from a specific block number
forklift wss://rpc.polkadot.io --block 22000000

# Fork from a specific block hash
forklift wss://rpc.polkadot.io --block 0xabc123...

# Use a custom port
forklift wss://rpc.polkadot.io --port 9000
```

The server exposes a standard JSON-RPC WebSocket endpoint. Point any polkadot-api client at `ws://localhost:3000`.

## API

You can also drive forklift programmatically:

```typescript
import { forklift } from "./src/forklift";
import { createWsServer } from "./src/serve";
import { Enum } from "polkadot-api";

const f = forklift(
  {
    type: "remote",
    value: {
      url: "wss://rpc.polkadot.io",
      atBlock: 22000000, // optional: block number or hex hash
    },
  },
  {
    // these are the defaults:
    buildBlockMode: Enum("timer", 100), // build a block 100ms after a tx arrives
    finalizeMode: Enum("timer", 2000), // finalize 2s after a block is built
    disableOnIdle: false, // skip on_idle hooks during block production
  }
);

// Expose as a WebSocket server
const server = createWsServer(f, { port: 3000 });
console.log(`Listening on ws://localhost:${server.port}`);
```

### `Forklift` interface

```typescript
interface Forklift {
  serve: JsonRpcProvider;

  // Produce a new block, returns the block hash
  newBlock(opts?: Partial<NewBlockOptions>): Promise<HexString>;

  // Move the best or finalized head to a given block hash
  changeBest(hash: HexString): Promise<void>;
  changeFinalized(hash: HexString): Promise<void>;

  // Apply storage overrides to a specific block
  setStorage(
    hash: HexString,
    changes: Record<string, Uint8Array>
  ): Promise<void>;

  // Diff a block's storage against its parent (or a given baseHash)
  getStorageDiff(
    hash: HexString,
    baseHash?: HexString
  ): Promise<
    Record<string, { value: Uint8Array | null; prev?: Uint8Array | null }>
  >;

  // Update forklift options at runtime
  changeOptions(opts: Partial<ForkliftOptions>): void;

  destroy(): void;
}
```

### Block modes

**`buildBlockMode`** controls when new blocks are produced:

- `Enum("manual")` — only on explicit `newBlock()` calls
- `Enum("timer", ms)` — automatically `ms` milliseconds after a transaction arrives (`0` = immediate)

**`finalizeMode`** controls when blocks are finalized:

- `Enum("manual")` — only on explicit `changeFinalized()` calls
- `Enum("timer", ms)` — automatically `ms` milliseconds after a block is built (`0` = same tick)

### Producing forks

Pass a `parent` hash to branch from any existing block:

```typescript
const base = await f.newBlock();

// Two independent forks from the same parent
const forkA = await f.newBlock({ parent: base, type: "fork" });
const forkB = await f.newBlock({ parent: base, type: "fork" });
```

### Storage overrides

```typescript
await f.setStorage(hash, {
  "0x...key": new Uint8Array([...value]),
});

const diff = await f.getStorageDiff(hash);
```

## Acknowledgements

Forklift is heavily inspired by [@acala-network/chopsticks](https://github.com/AcalaNetwork/chopsticks) and reuses its smoldot-based WASM executor (`@acala-network/chopsticks-executor`) for running runtime APIs locally. Thank you to the Acala team for their foundational work.
