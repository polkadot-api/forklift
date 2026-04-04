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
- `getDescendantNodes(node, prefix, nibbles)` - get all nodes with values under a prefix
- `forEachDescendant(root, cb)` - iterate all descendant nodes (used for marking exhaustive)

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
  header: BlockHeader; // Decoded block header
  runtime: RuntimeVersion; // Runtime version info
  hasNewRuntime?: boolean; // Flag indicating runtime upgrade
  children: HexString[]; // Child block hashes (for fork management)
}

interface Chain {
  blocks$: Observable<Record<HexString, Block>>;
  newBlocks$: Observable<HexString>; // Emits when new blocks are added
  best$: Observable<HexString>;
  finalized$: Observable<HexString>;

  getBlock(hash): Block | undefined;
  newBlock(opts?): void;
  changeBest(hash): void;
  changeFinalized(hash): void;
  setStorage(hash, changes): void;

  // Storage queries (lazy-load from source)
  // Return StorageNode to expose hash for merkle proofs
  getStorage(hash, key): Promise<StorageNode>;
  getStorageBatch(hash, keys): Promise<StorageNode[]>;
  getStorageDescendants(hash, prefix): Promise<Record<HexString, StorageNode>>;
}
```

**Design decisions:**

- `createChain(source)` is async - fetches runtime code and runtime version from source at init
- Each block has its own `storageRoot` trie - forks get independent state
- Storage is **lazy-loaded**: queries check block's trie first, then fall back to source
- The `initialBlock.storageRoot` is mutated as data loads from source
- Newer blocks check both their own trie AND initialBlock's trie (for newly loaded data)
- `setStorage` directly modifies a block's storageRoot (for staging changes)
- `changeFinalized` validates the block is a descendant of current finalized, updates best if needed
- `changeBest` validates the block is a descendant of finalized
- Storage methods return `StorageNode` (not raw bytes) to expose hash for merkle proofs
- `newBlocks$` emits block hashes as they're added (used by RPC subscriptions)
- `getBlock` provides synchronous access to loaded blocks
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
  getStorageDiff(hash): Promise<Record<string, Uint8Array | null>>;
  setBuildBlockMode(mode): void; // Not yet implemented
}
```

**Build block modes (enum defined, not yet functional):**

- `Manual` - blocks created only when `newBlock()` called
- `Instant` - new block after each transaction
- `Batch` - batch transactions into blocks

**NewBlockOptions** supports:

- `type` - "best", "finalized", or "fork"
- `parent` - which block to build on (enables forking)
- `unsafeBlockHeight` - override block height
- `transactions` - extrinsics to include
- `dmp`, `hrmp`, `ump` - parachain messages
- `storage` - storage overrides

### Executor (`src/executor.ts`)

Wrapper around `@acala-network/chopsticks-executor` (smoldot-based WASM executor) for running runtime API calls locally.

```typescript
// Run a runtime API call
const result = await runRuntimeCall({
  chain,
  hash: blockHash,
  call: "Metadata_metadata_at_version",
  params: "0x0f", // SCALE-encoded version 15
  mockSignatureHost: false,
});

// Get runtime version from code bytes
const version = await getRuntimeVersion(codeBytes);
```

**Key functions:**

- `runRuntimeCall({ chain, hash, call, params, mockSignatureHost? })` - execute a runtime API
- `getRuntimeVersion(code: Uint8Array)` - get runtime version info from WASM code

**JsCallback implementation:**

- `getStorage` - delegates to `chain.getStorage`
- `getNextKey` - uses `chain.getStorageDescendants` to find next key after given key
- `offchainTimestamp` - returns `Date.now()`
- `offchainRandomSeed` - returns crypto random bytes
- `offchainGetStorage`, `offchainSubmitTransaction` - not implemented (return undefined/false)

### JSON-RPC Server (`src/serve.ts`)

Creates a `JsonRpcProvider` that routes requests to RPC method handlers.

```typescript
const createServer = (chain: Promise<Chain>): JsonRpcProvider
```

**Design decisions:**

- Each connection maintains its own context (subscriptions, pinned blocks)
- Implements `rpc_methods` for method discovery
- Routes to handlers in `src/rpc/` directory

### chainHead_v1 RPC Methods (`src/rpc/chainHead_v1.ts`)

Implements the new JSON-RPC spec chainHead methods:

**`chainHead_v1_follow`**
- Creates subscription with pinned blocks tracking
- Sends `initialized` event with finalized blocks (up to 5 ancestors)
- Emits `newBlock`, `bestBlockChanged`, `finalized` events
- Tracks operations per subscription

**`chainHead_v1_header`**
- Returns SCALE-encoded block header
- Validates block is pinned in subscription

**`chainHead_v1_storage`**
- Supports `value`, `hash`, `closestDescendantMerkleValue` query types
- Returns async operation with `operationStorageItems` events
- TODO: child trie support, pagination, descendant queries

**`chainHead_v1_call`**
- Executes runtime API calls via executor
- Returns `operationCallDone` with output or `operationError` on failure

**RPC Utilities (`src/rpc/rpc_utils.ts`)**
- `Connection` interface with subscription context
- `RpcMethod` type definition
- Helpers: `getParams()`, `getUuid()`, `respond()`

### Block Builder (`src/block-builder/`)

Creates new parachain blocks by executing runtime APIs.

**`create-block.ts`**
- Orchestrates block creation: `Core_initialize_block` → `BlockBuilder_apply_extrinsic` (for each inherent/tx) → `BlockBuilder_finalize_block`
- Uses `mockSignatureHost: true` to bypass BABE signature verification on relay chain headers

**`set-validation-data.ts`**
- Generates the `ParachainSystem.set_validation_data` inherent required for every parachain block
- Extracts previous validation data from parent block's body
- Injects parent header into relay chain proof as `Paras::Heads(paraId)` to signal block inclusion
- Uses chopsticks-executor's `decode_proof`/`create_proof` for Merkle trie manipulation
- Preserves `PRESERVE_PROOFS` (EPOCH_INDEX, AUTHORITIES, etc.) from existing proof
- Updates `relay_parent_descendants` headers to maintain chain integrity after state root change

**`timestamp.ts`**
- Generates the `Timestamp.set` inherent with incremented timestamp

## Dependencies

- `@polkadot-api/substrate-client` - Low-level substrate RPC client
- `@polkadot-api/observable-client` - RxJS wrapper (currently unused, may be useful later)
- `@polkadot-api/substrate-bindings` - SCALE codecs, `BlockHeader`, `Binary.fromHex/toHex`, `Blake2128`
- `@polkadot-api/ws-provider` + `@polkadot-api/ws-middleware` - WebSocket transport
- `@acala-network/chopsticks-executor` - smoldot-based WASM executor for runtime calls
- `rxjs` - Reactive streams for chain state

## Implementation Status

- [x] `Source` interface defined
- [x] `createRemoteSource` implemented using archive API
- [ ] Genesis source
- [x] `Storage` trie implementation
- [x] `Chain` data structures and observables
- [x] `Chain.changeBest`, `changeFinalized`, `setStorage`
- [x] `Chain.getStorage`, `getStorageBatch`, `getStorageDescendants`
- [x] `Chain.newBlock` - block creation with inherents
- [x] `Forklift` basic wiring (creates source + chain)
- [x] `Executor` - runtime API calls via chopsticks-executor
- [x] JSON-RPC server (`serve`)
- [x] `chainHead_v1_follow`, `chainHead_v1_header`, `chainHead_v1_storage`, `chainHead_v1_call`
- [ ] `chainHead_v1_storage` child trie support
- [ ] `chainHead_v1_storage` pagination
- [ ] `chainHead_v1_storage` descendant queries (`descendantsValues`, `descendantsHashes`)

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
