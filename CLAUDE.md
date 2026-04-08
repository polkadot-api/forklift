# Forklift

A remake of [AcalaNetwork/chopsticks](https://github.com/AcalaNetwork/chopsticks) built with polkadot-api.

## Key Features

1. **Multiple forks**: Unlike chopsticks which has one single head, forklift supports multiple concurrent forks
2. **polkadot-api native**: Built entirely on polkadot-api instead of polkadot-js
3. **smoldot runtime execution**: All runtime calls execute locally via smoldot, not on the remote node
4. **New JSON-RPC spec only**: Uses only the new archive RPC methods, no legacy RPCs

## Architecture

### Source (`src/source.ts`)

Abstraction over where chain data comes from. A Source resolves a single block and supports storage queries relative to that block.

```typescript
interface Source {
  block: Promise<{
    blockHash: HexString;
    header: BlockHeader;
    body: Uint8Array[];
  }>;

  getStorage(key): Promise<Uint8Array | null>;
  getStorageBatch(keys): Promise<(Uint8Array | null)[]>;
  getStorageDescendants(prefix): Promise<Record<HexString, Uint8Array>>;
  getChainSpecData(): Promise<ChainSpecData>;
  destroy(): void;
}
```

**Design decisions:**

- `block` is a Promise (resolved asynchronously at init time) containing hash, header, and body
- Returns `Uint8Array` not hex strings — binary-first
- `destroy()` disconnects the underlying client
- No `getCode()` — runtime code is just storage at key `:code` (`0x3a636f6465`)
- No `call()` — runtime calls happen locally via smoldot

**Source types:**

- `createRemoteSource(url, { atBlock? })` — connects to a polkadot-sdk node via WebSocket; `atBlock` can be a block number or hex hash
- `createGenesisSource()` — creates chain from scratch with provided storage (TODO)

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

- `createRoot()` — create empty trie
- `insertValue(root, key, nibbles, value)` — returns new trie with value inserted
- `deleteValue(root, key, nibbles)` — soft delete (sets value to null, doesn't remove node)
- `getNode(root, key, nibbles)` — traverse to node at key
- `getDiff(base, initialRoot, other)` — compute storage diff between two tries
- `getDescendantNodes(node, prefix, nibbles)` — get all nodes with values under a prefix
- `forEachDescendant(root, cb)` — iterate all descendant nodes (used for marking exhaustive)

**Design decisions:**

- Immutable updates with structural sharing — inserting returns a new root
- Soft deletes (value = null) to distinguish "deleted" from "not loaded"
- `exhaustive` flag marks when all descendants have been fetched from source
- `exhaustive` must be preserved through insert/delete operations on path nodes
- Hash computed via Blake2128 for quick equality checks

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
  body: Uint8Array[]; // Block extrinsics
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
  newBlock(opts?): Promise<Block>; // Returns the new Block
  changeBest(hash): void;
  changeFinalized(hash): void;
  setStorage(hash, changes): void;

  // Storage queries (lazy-load from source)
  // Return StorageNode to expose hash for merkle proofs
  getStorage(hash, key): Promise<StorageNode>;
  getStorageBatch(hash, keys): Promise<StorageNode[]>;
  getStorageDescendants(hash, prefix): Promise<Record<HexString, StorageNode>>;

  // Returns diff relative to parent (or baseHash), with prev value when known
  getStorageDiff(
    hash,
    baseHash?
  ): Promise<
    Record<string, { value: Uint8Array | null; prev?: Uint8Array | null }>
  >;
}
```

**Design decisions:**

- `createChain(source)` is synchronous — returns chain immediately, initial block loads lazily
- Each block has its own `storageRoot` trie — forks get independent state
- Block also has `body: Uint8Array[]` (extrinsics from source block, then built blocks)
- Storage is **lazy-loaded**: queries check block's trie first, then fall back to source
- The `initialBlock.storageRoot` is mutated as data loads from source
- Newer blocks check both their own trie AND initialBlock's trie (for newly loaded data)
- `setStorage` directly modifies a block's storageRoot (for staging changes)
- `changeFinalized` validates the block is a descendant of current finalized, updates best if needed
- `changeBest` validates the block is a descendant of finalized
- Storage methods return `StorageNode` (not raw bytes) to expose hash for merkle proofs
- `newBlocks$` emits block hashes as they're added (used by RPC subscriptions)
- `getBlock` provides synchronous access to loaded blocks
- `getStorageDiff` compares against parent by default, or a specified `baseHash`
- No block pruning — forklift is for short-lived test scenarios, not long-running nodes
- Runtime code is cached to `code.bin` to speed up restarts during development. This will be removed (or made properly) before release.

**`finalizedAndPruned$`** is a helper observable exported from chain.ts that emits `{ finalized: HexString[], pruned: HexString[] }` whenever finalization advances, used by chainHead_v1_follow.

### Codecs (`src/codecs.ts`)

Metadata-driven dynamic codec building. Fetches and caches runtime metadata per block.

**Key functions:**

- `setBlockMeta(chain, block)` — fetches metadata (`Metadata_metadata_at_version` v15) for a block; reuses parent's metadata if runtime hasn't changed. Must be called after each new block is added to the chain.
- `getConstant(block, pallet, entry)` — decode a runtime constant from metadata
- `getStorageCodecs(block, pallet, entry)` — build storage key/value codecs for a storage entry
- `getTxCodec(block, pallet, tx)` — build call codec for a transaction
- `getCallCodec(block, pallet, api)` — build codec for a runtime API call
- `getCallData(block, pallet, tx, params)` — encode call data (pallet index + encoded args)
- `getExtrinsicDecoder(block)` — get an extrinsic decoder using `@polkadot-api/tx-utils`
- `unsignedExtrinsic(callData)` — wrap call data as a bare (unsigned) extrinsic

### Forklift (`src/forklift.ts`)

The main entry point that mocks a polkadot-sdk node.

```typescript
interface Forklift {
  serve: JsonRpcProvider; // JSON-RPC server for clients to connect
  newBlock(opts?): Promise<HexString>; // Returns hash of the new block
  changeBest(hash): Promise<void>;
  changeFinalized(hash): Promise<void>;
  setStorage(hash, changes): Promise<void>;
  getStorageDiff(
    hash,
    baseHash?
  ): Promise<
    Record<string, { value: Uint8Array | null; prev?: Uint8Array | null }>
  >;
  changeOptions(opts): void; // Dynamically update ForkliftOptions
  destroy(): void;
}

interface ForkliftOptions {
  buildBlockMode: DelayMode; // manual | timer(ms)
  finalizeMode: DelayMode; // manual | timer(ms)
  disableOnIdle?: boolean;
  mockSignatureHost?: (signature: Uint8Array) => boolean;
}
```

**`DelayMode`** is `Enum<{ manual: undefined; timer: number }>`:

- `Enum("manual")` — blocks/finalization only happen on explicit calls
- `Enum("timer", ms)` — auto-triggers after delay in milliseconds (0 = instant)

**Defaults:** `buildBlockMode: timer(100)`, `finalizeMode: timer(2000)`

**Block production flow:**

- `newBlock()` is serialized via a queue (`buildBlockQueue`) — concurrent calls wait
- Transactions from the tx pool are automatically included
- If `automatic=true` and no transactions are ready, the block is skipped
- After building, best is updated if the new block is taller than current best
- Finalization uses a timer (or is immediate if `finalizeMode.timer === 0`)
- `changeFinalized` clears pending finalization timers before applying

**Transaction pool integration:**

- `txPool.txAdded$` triggers automatic block production (respecting `buildBlockMode`)
- `blocksEnqueued` counter prevents duplicate automatic triggers

**NewBlockOptions** supports:

- `type` — "best", "finalized", or "fork"
- `parent` — which block to build on (enables forking)
- `unsafeBlockHeight` — override block height
- `transactions` — extrinsics to include
- `dmp`, `hrmp`, `ump` — parachain messages
- `storage` — storage overrides
- `disableOnIdle` — skip on_idle hooks during block finalization

### Transaction Pool (`src/txPool.ts`)

Validates and orders transactions for inclusion in blocks.

```typescript
interface TxPool {
  addTx(tx: Uint8Array): Promise<void>;
  getTxsForBlock(block: Block): Promise<Uint8Array[]>;
  destroy(): void;
  txAdded$: Observable<void>;
}
```

**Design decisions:**

- Transactions are validated via `TaggedTransactionQueue_validate_transaction` against alive blocks (finalized + its descendants)
- Each block maintains its own tx pool (inherited from parent, minus included txs)
- Pruned blocks' tx pools are cleared
- `getTxsForBlock` awaits all pending validations, prunes invalid txs, then topologically sorts by `requires`/`provides` tags, with priority-based ordering within groups
- `txAdded$` emits after a tx is added, allowing forklift to auto-build blocks

### Pre-queries (`src/prequeries.ts`)

Pre-fetches storage ranges needed during block building to reduce latency.

- Runs once on finalized block at startup
- Pre-fetches `Mmr.Nodes` and `Paras.Heads` storage descendants

### Executor (`src/executor.ts`)

Wrapper around `@acala-network/chopsticks-executor` (smoldot-based WASM executor) for running runtime API calls locally.

```typescript
// Run a runtime API call
const result = await runRuntimeCall({
  chain,
  hash: blockHash,
  call: "Metadata_metadata_at_version",
  params: "0x0f", // SCALE-encoded version 15
  storageOverrides: Record<HexString, HexString | null>, // ephemeral overlay
  mockSignatureHost: boolean,
});

// Returns { result, storageDiff, offchainStorageDiff, runtimeLogs }

// Get runtime version from code bytes
const version = await getRuntimeVersion(codeBytes);
```

**`storageOverrides`** is an in-memory overlay applied before chain storage lookups — used during block building to pass accumulated state changes between runtime calls.

**JsCallback implementation:**

- `getStorage` — checks `storageOverrides` first, then delegates to `chain.getStorage`
- `getNextKey` — uses `chain.getStorageDescendants` merged with overlay to find next key
- `offchainTimestamp` — returns `Date.now()`
- `offchainRandomSeed` — returns crypto random bytes
- `offchainGetStorage`, `offchainSubmitTransaction` — not implemented (return undefined/false)

### JSON-RPC Server (`src/serve.ts`)

Creates a `JsonRpcProvider` that routes requests to RPC method handlers.

```typescript
const createServer = (ctx: ServerContext): JsonRpcProvider
// ServerContext = { source, chain, txPool, newBlock }
```

**Implemented methods:**

| Method                       | File              |
| ---------------------------- | ----------------- |
| `chainHead_v1_follow`        | chainHead_v1.ts   |
| `chainHead_v1_unfollow`      | chainHead_v1.ts   |
| `chainHead_v1_header`        | chainHead_v1.ts   |
| `chainHead_v1_body`          | chainHead_v1.ts   |
| `chainHead_v1_storage`       | chainHead_v1.ts   |
| `chainHead_v1_call`          | chainHead_v1.ts   |
| `chainHead_v1_stopOperation` | chainHead_v1.ts   |
| `chainHead_v1_unpin`         | chainHead_v1.ts   |
| `chainSpec_v1_chainName`     | chainSpec_v1.ts   |
| `chainSpec_v1_genesisHash`   | chainSpec_v1.ts   |
| `chainSpec_v1_properties`    | chainSpec_v1.ts   |
| `transaction_v1_broadcast`   | transaction_v1.ts |
| `transaction_v1_stop`        | transaction_v1.ts |
| `dev_newBlock`               | dev.ts            |
| `dev_setStorage`             | dev.ts            |
| `rpc_methods`                | serve.ts (inline) |

**Design decisions:**

- Each connection maintains its own context (subscriptions, pinned blocks)
- Routes to handlers in `src/rpc/` directory

### chainHead_v1 RPC Methods (`src/rpc/chainHead_v1.ts`)

**`chainHead_v1_follow`**

- Creates subscription with pinned blocks tracking
- Sends `initialized` event with finalized blocks (up to 5 ancestors) and their children
- Emits `newBlock`, `bestBlockChanged`, `finalized` events
- Sends `stop` event if blocks arrive non-sequentially (gaps in block numbers)
- Tracks operations per subscription

**`chainHead_v1_header`**

- Returns SCALE-encoded block header
- Validates block is pinned in subscription

**`chainHead_v1_body`**

- Returns block body (extrinsics) as hex strings via `operationBodyDone`

**`chainHead_v1_storage`**

- Supports `value`, `hash`, `closestDescendantMerkleValue`, `descendantsValues`, `descendantsHashes` query types
- Returns async operation with `operationStorageItems` events and `operationStorageDone` on completion
- TODO: child trie support, pagination

**`chainHead_v1_call`**

- Executes runtime API calls via executor
- Returns `operationCallDone` with output or `operationError` on failure

**`chainHead_v1_unpin`**

- Validates no duplicate hashes in request
- Removes hashes from pinned set

**`chainHead_v1_stopOperation`**

- Cancels an in-progress operation by unsubscribing

**RPC Utilities (`src/rpc/rpc_utils.ts`)**

- `Connection` interface with subscription context
- `ServerContext` type: `{ source, chain, txPool, newBlock }`
- `RpcMethod` type definition
- Helpers: `getParams()`, `getUuid()`, `respond()`, `errorResponse()`

### Block Builder (`src/block-builder/`)

Creates new parachain/relay chain blocks by executing runtime APIs.

**`create-block.ts`**

Orchestrates block creation:

1. `timestampInherent` — generate `Timestamp.set`
2. `setValidationDataInherent` — generate `ParachainSystem.set_validation_data` (parachain only, returns null if not applicable)
3. `paraInherentEnterInherent` — generate `ParaInherent.enter` (relay chain only, returns null if not applicable)
4. User transactions (from tx pool or explicit)
5. `Core_initialize_block` → `BlockBuilder_apply_extrinsic` (for each) → `BlockBuilder_finalize_block`

Storage changes accumulate in `storageOverrides` across all runtime calls.

**`disableOnIdle`** — before `BlockBuilder_finalize_block`, temporarily sets `System.BlockWeight` to `BlockWeights.max_block` via storage override, preventing `on_idle` hooks (e.g. rebagging) from running. The override is reverted after finalization so the real weight is recorded.

**Digest handling** — `buildNextDigests` increments the slot by 1 for each new block:

- AURA: replaces `preRuntime` digest slot value with `currentSlot + 1`
- BABE: decodes `BabePreDigest` variant, updates slot field
- Other digests are passed through unchanged

**`set-validation-data.ts`**

- Generates the `ParachainSystem.set_validation_data` inherent required for every parachain block
- Extracts previous validation data from parent block's body
- Injects parent header into relay chain proof as `Paras::Heads(paraId)` to signal block inclusion
- Uses chopsticks-executor's `decode_proof`/`create_proof` for Merkle trie manipulation
- Preserves `PRESERVE_PROOFS` (EPOCH_INDEX, AUTHORITIES, etc.) from existing proof
- Updates `relay_parent_descendants` headers to maintain chain integrity after state root change

**`para-enter.ts`**

- Generates the `ParaInherent.enter` inherent for relay chain blocks
- Encodes parent header using `runtimeBlockHeader` (runtime-native format, different from polkadot-api's `BlockHeader`)
- Passes empty bitfields, backed_candidates, and disputes

**`timestamp.ts`**

- Generates the `Timestamp.set` inherent with incremented timestamp

**`slot-utils.ts`**

- `getCurrentSlot` — derives current slot from `Timestamp.Now` / slot duration
- `getSlotDuration` — checks BABE, AsyncBacking, or AURA slot duration constants
- `getCurrentTimestamp` — reads `Timestamp.Now` storage with fallback to `Date.now()`
- `runtimeBlockHeader` — codec for the runtime-native block header format (used in SCALE encoding for runtime calls)

### Dev RPC (`src/rpc/dev.ts`)

- `dev_newBlock` — triggers block production, accepts optional `parent` and `unsafeBlockHeight`
- `dev_setStorage` — applies storage overrides to best (or specified) block; accepts array of `[key, value | null]` pairs

### chainSpec_v1 RPC (`src/rpc/chainSpec_v1.ts`)

Delegates to `source.getChainSpecData()` for chain name, genesis hash, and properties.

## Dependencies

- `@polkadot-api/substrate-client` — Low-level substrate RPC client
- `@polkadot-api/metadata-builders` — Dynamic codec building from metadata (`getDynamicBuilder`, `getLookupFn`)
- `@polkadot-api/substrate-bindings` — SCALE codecs, `BlockHeader`, `Binary`, `Blake2256`, `blockHeader`, `decAnyMetadata`, `unifyMetadata`
- `@polkadot-api/tx-utils` — Extrinsic decoding
- `@polkadot-api/ws-provider` + `@polkadot-api/ws-middleware` — WebSocket transport
- `@acala-network/chopsticks-executor` — smoldot-based WASM executor for runtime calls
- `polkadot-api` — `createClient`, `Binary`, `Enum`, `HexString`, `BlockHeader`
- `rxjs` — Reactive streams for chain state

## Implementation Status

- [x] `Source` interface defined
- [x] `createRemoteSource` implemented using archive API
- [ ] Genesis source
- [x] `Storage` trie implementation
- [x] `Chain` data structures and observables
- [x] `Chain.changeBest`, `changeFinalized`, `setStorage`
- [x] `Chain.getStorage`, `getStorageBatch`, `getStorageDescendants`, `getStorageDiff`
- [x] `Chain.newBlock` — block creation with inherents
- [x] `Forklift` — full wiring with tx pool, auto block building, finalization timers
- [x] `Executor` — runtime API calls via chopsticks-executor
- [x] `Codecs` — dynamic metadata-driven codec building
- [x] `TxPool` — transaction validation, ordering, and automatic block triggering
- [x] `Prequeries` — background prefetch of Mmr.Nodes and Paras.Heads
- [x] JSON-RPC server (`serve`)
- [x] `chainHead_v1_follow`, `chainHead_v1_header`, `chainHead_v1_body`, `chainHead_v1_storage`, `chainHead_v1_call`, `chainHead_v1_unpin`, `chainHead_v1_stopOperation`, `chainHead_v1_unfollow`
- [x] `chainSpec_v1_chainName`, `chainSpec_v1_genesisHash`, `chainSpec_v1_properties`
- [x] `transaction_v1_broadcast`, `transaction_v1_stop`
- [x] `dev_newBlock`, `dev_setStorage`
- [x] Relay chain support (`ParaInherent.enter` inherent)
- [x] `disableOnIdle` option to skip on_idle hooks during block production
- [x] AURA and BABE digest slot handling
- [ ] `chainHead_v1_storage` child trie support
- [ ] `chainHead_v1_storage` pagination

## Usage

```typescript
import { forklift } from "./src/forklift";
import { Enum } from "polkadot-api";

const f = forklift(
  {
    type: "remote",
    value: { url: "wss://rpc.polkadot.io" },
  },
  {
    disableOnIdle: true,
    buildBlockMode: Enum("timer", 100),
    finalizeMode: Enum("timer", 2000),
  }
);

const hash = await f.newBlock();
console.log("new block:", hash);
```

## Runtime

- Uses Bun as the JavaScript runtime
- TypeScript with strict mode
- Run with `bun run index.ts`
- Type check with `bunx tsc --noEmit`
- Runtime code is cached to `code.bin` to speed up subsequent runs
