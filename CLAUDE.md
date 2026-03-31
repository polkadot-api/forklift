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
- Genesis source (TODO) - creates chain from scratch with provided storage

### Chain (`src/chain.ts`)

Manages the block tree with multiple forks. Uses RxJS observables.

```typescript
interface Block {
  hash: HexString;
  parent: HexString | null; // null for the initial block from source
  height: number;
  code: Uint8Array;
  storageDiff: Record<HexString, Uint8Array | null>; // null means deleted
}

interface Chain {
  blocks$: Observable<Record<HexString, Block>>;
  best$: Observable<HexString>;
  finalized$: Observable<HexString>;

  newBlock(opts?): void;
  changeBest(hash): void;
  changeFinalized(hash): void;
  setStorage(hash, changes): void; // Stage storage changes for next block on this parent
}
```

**Internal state:**

- `blocks` - map of hash → Block
- `pendingStorage` - map of hash → staged storage changes (applied when building child block)

**Design decisions:**

- `createChain(source)` is async - fetches runtime code from source at init
- Initial block has `parent: null` and empty `storageDiff` (state comes from source)
- `storageDiff` values can be `null` to represent deletions
- `changeFinalized` validates the block is an ancestor of best, then prunes unreachable blocks
- Pruning keeps: ancestors of finalized + descendants of finalized (active forks)

### Forklift (`src/forklift.ts`)

The main entry point that mocks a polkadot-sdk node.

```typescript
interface Forklift {
  serve: JsonRpcProvider; // JSON-RPC server for clients to connect
  newBlock(opts?): void; // Create a new block
  changeBest(hash): void; // Change best block
  changeFinalized(hash): void; // Change finalized block
  setStorage(changes): void; // Modify storage for next block
  getStorageDiff(hash): Record<string, Uint8Array>;
  setBuildBlockMode(mode): void;
}
```

**Build block modes:**

- `Manual` - blocks created only when `newBlock()` called
- `Instant` - new block after each transaction
- `Batch` - batch transactions into blocks

**NewBlockOptions** supports:

- `parent` - which block to build on (enables forking)
- `transactions` - extrinsics to include
- `dmp`, `hrmp`, `ump` - parachain messages
- `storage` - storage overrides

## Dependencies

- `@polkadot-api/substrate-client` - Low-level substrate RPC client
- `@polkadot-api/observable-client` - RxJS wrapper (currently unused, may be useful later)
- `@polkadot-api/substrate-bindings` - SCALE codecs, `BlockHeader`, `Binary.fromHex/toHex`
- `@polkadot-api/ws-provider` + `@polkadot-api/ws-middleware` - WebSocket transport
- `rxjs` - Reactive streams for chain state

## Implementation Status

- [x] `Source` interface defined
- [x] `createRemoteSource` implemented using archive API
- [ ] Genesis source
- [x] `Chain` data structures and observables
- [x] `Chain.changeBest`, `changeFinalized`, `setStorage`
- [ ] `Chain.newBlock` (requires smoldot)
- [ ] `Forklift` implementation
- [ ] smoldot integration for runtime execution
- [ ] JSON-RPC server (`serve`)

## Usage

```typescript
import { createRemoteSource } from "./src/source";

const source = await createRemoteSource("wss://rpc.polkadot.io", {
  atBlock: 12345678, // or hash, or omit for finalized
});

console.log(source.header.number);
const value = await source.getStorage("0x...");
source.disconnect();
```

## Runtime

- Uses Bun as the JavaScript runtime
- TypeScript with strict mode
- Run with `bun run index.ts`
- Type check with `bunx tsc --noEmit`
