# Forklift

A remake of [AcalaNetwork/chopsticks](https://github.com/AcalaNetwork/chopsticks) built with polkadot-api.

## Key Features

1. **Multiple forks**: Unlike chopsticks which has one single head, forklift supports multiple concurrent forks
2. **polkadot-api native**: Built entirely on polkadot-api instead of polkadot-js
3. **smoldot runtime execution**: All runtime calls execute locally via smoldot, not on the remote node
4. **New JSON-RPC spec only**: Uses only the new archive RPC methods, no legacy RPCs

## Architecture

### Source (`src/source.ts`)

Abstraction over where chain data comes from. A Source is **pinned to a single block** - all storage queries are relative to that block.

```typescript
interface Source {
  blockHash: HexString; // The pinned block hash
  header: BlockHeader; // Decoded block header
  getStorage(key): Promise<Uint8Array | null>;
  getStorageBatch(keys): Promise<(Uint8Array | null)[]>;
  getStorageDescendants(prefix): Promise<Record<HexString, Uint8Array>>;
  disconnect(): void;
}
```

**Design decisions:**

- Returns `Uint8Array` not hex strings - binary-first
- No `getCode()` - runtime code is just storage at key `:code` (`0x3a636f6465`)
- No `call()` - runtime calls happen locally via smoldot
- No block hash params on methods - source is pinned to one block
- Properties like `header` and `blockHash` are loaded at creation time

**Source types:**

- `createRemoteSource(url, { atBlock? })` - connects to a polkadot-sdk node via WebSocket
- `createGenesisSource()` - creates chain from scratch with provided storage (TODO)

### Storage (`src/storage.ts`)

Immutable 16-way radix trie (nibble-based) for efficient storage management with structural sharing.

```typescript
interface StorageNode {
  hash: Uint8Array; // Blake2128 hash of node contents
  children: Array<StorageNode>; // 16 children (one per nibble)
  value?: Uint8Array | null; // null = soft deleted
  exhaustive?: boolean; // true = all descendants loaded from source
}
```

**Key functions:**

- `createRoot()` - create empty trie
- `insertValue(root, key, nibbles, value)` - returns new trie with value inserted
- `deleteValue(root, key, nibbles)` - soft delete (sets value to null, doesn't remove node)
- `getNode(root, key, nibbles)` - traverse to node at key
- `getDiff(base, other)` - compute storage diff between two tries
- `getDescendantValues(node, prefix, nibbles)` - get all values under a prefix

**Design decisions:**

- Immutable updates with structural sharing - inserting returns a new root
- Soft deletes (value = null) to distinguish "deleted" from "not loaded"
- `exhaustive` flag marks when all descendants have been fetched from source
- `exhaustive` must be preserved through insert/delete operations on path nodes
- Hash computed via Blake2128 for quick equality checks
- `getDiff` returns nibble counts for correctness, but Chain works with full bytes (can ignore)

### Chain (`src/chain.ts`)

Manages the block tree with multiple forks. Uses RxJS observables.

```typescript
interface Block {
  hash: HexString;
  parent: HexString; // 0x000...000 for initial block
  height: number;
  code: Uint8Array;
  storageRoot: StorageNode; // Immutable trie root for this block's state
}

interface Chain {
  blocks$: Observable<Record<HexString, Block>>;
  best$: Observable<HexString>;
  finalized$: Observable<HexString>;

  newBlock(opts?): void;
  changeBest(hash): void;
  changeFinalized(hash): void;
  setStorage(hash, changes): void;

  // Storage queries (lazy-load from source)
  getStorage(hash, key): Promise<Uint8Array | null>;
  getStorageBatch(hash, keys): Promise<(Uint8Array | null)[]>;
  getStorageDescendants(hash, prefix): Promise<Record<HexString, Uint8Array>>;
}
```

**Design decisions:**

- `createChain(source)` is async - fetches runtime code from source at init
- Each block has its own `storageRoot` trie - forks get independent state
- Storage is **lazy-loaded**: queries check block's trie first, then fall back to source
- The `initialBlock.storageRoot` is mutated as data loads from source
- Newer blocks check both their own trie AND initialBlock's trie (for newly loaded data)
- `setStorage` directly modifies a block's storageRoot (for staging changes)
- `changeFinalized` validates the block is a descendant of current finalized
- `changeBest` validates the block is a descendant of finalized
- No block pruning - forklift is for short-lived test scenarios, not long-running nodes

### Forklift (`src/forklift.ts`)

The main entry point that mocks a polkadot-sdk node.

```typescript
interface Forklift {
  serve: JsonRpcProvider; // JSON-RPC server for clients to connect
  newBlock(opts?): Promise<void>;
  changeBest(hash): Promise<void>;
  changeFinalized(hash): Promise<void>;
  setStorage(hash, changes): Promise<void>;
  getStorageDiff(hash): Promise<Record<string, Uint8Array>>;
  setBuildBlockMode(mode): void;
}
```

**Build block modes:**

- `Manual` - blocks created only when `newBlock()` called
- `Instant` - new block after each transaction
- `Batch` - batch transactions into blocks

**NewBlockOptions** supports:

- `type` - "best", "finalized", or "fork"
- `parent` - which block to build on (enables forking)
- `transactions` - extrinsics to include
- `dmp`, `hrmp`, `ump` - parachain messages
- `storage` - storage overrides

## Dependencies

- `@polkadot-api/substrate-client` - Low-level substrate RPC client
- `@polkadot-api/observable-client` - RxJS wrapper (currently unused, may be useful later)
- `@polkadot-api/substrate-bindings` - SCALE codecs, `BlockHeader`, `Binary.fromHex/toHex`, `Blake2128`
- `@polkadot-api/ws-provider` + `@polkadot-api/ws-middleware` - WebSocket transport
- `rxjs` - Reactive streams for chain state

## Implementation Status

- [x] `Source` interface defined
- [x] `createRemoteSource` implemented using archive API
- [ ] Genesis source
- [x] `Storage` trie implementation
- [x] `Chain` data structures and observables
- [x] `Chain.changeBest`, `changeFinalized`, `setStorage`
- [x] `Chain.getStorage`, `getStorageBatch`, `getStorageDescendants`
- [ ] `Chain.newBlock` (requires smoldot)
- [x] `Forklift` basic wiring (creates source + chain)
- [ ] smoldot integration for runtime execution
- [ ] JSON-RPC server (`serve`)

## Usage

```typescript
import { forklift } from "./src/forklift";

const f = forklift({
  source: {
    type: "remote",
    value: { url: "wss://rpc.polkadot.io", atBlock: 12345678 },
  },
});

await f.changeBest("0x...");
```

## Runtime

- Uses Bun as the JavaScript runtime
- TypeScript with strict mode
- Run with `bun run index.ts`
- Type check with `bunx tsc --noEmit`
