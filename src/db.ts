import { Database } from "bun:sqlite";
import {
  Blake2128,
  blockHeader as blockHeaderCodec,
} from "@polkadot-api/substrate-bindings";
import type { HexString } from "polkadot-api";
import type { Block } from "./block-builder/create-block";
import type { RuntimeVersion } from "./executor";
import type { StorageNode } from "./storage";

// ─── Public types ────────────────────────────────────────────────────────────

export interface DbState {
  initialBlock: Block;
  blocks: Block[];
  best: HexString;
  finalized: HexString;
}

export interface Db {
  /** Insert or update a block plus any new trie nodes it references. */
  saveBlock(block: Block, isInitial?: boolean): void;
  /** Persist new trie nodes reachable from root (called after each lazy storage load on the initial block). */
  saveStorageRoot(root: StorageNode): void;
  /** Update the exhaustive flag for nodes that already have a dbId. */
  markExhaustive(nodes: StorageNode[]): void;
  /** Upsert the best/finalized chain pointers. */
  setChainState(best: HexString, finalized: HexString): void;
  /** Load persisted state. Returns null if the DB is empty. */
  load(): DbState | null;
  close(): void;
}

// ─── Implementation ──────────────────────────────────────────────────────────

export function createDb(path: string): Db {
  const sqlite = new Database(path);
  sqlite.run("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");

  sqlite.run(`
    CREATE TABLE IF NOT EXISTS storage_nodes (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      hash     BLOB    NOT NULL,
      -- 0 = undefined (not loaded), 1 = present, 2 = soft-deleted (null)
      val_state INTEGER NOT NULL DEFAULT 0,
      value    BLOB,
      exhaustive INTEGER NOT NULL DEFAULT 0,
      -- 64 bytes: 16 × int32LE, −1 means no child at that nibble
      children BLOB    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS codes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint BLOB    NOT NULL UNIQUE,
      code        BLOB    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blocks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      hash            TEXT    NOT NULL UNIQUE,
      parent_hash     TEXT    NOT NULL,
      height          INTEGER NOT NULL,
      storage_root_id INTEGER NOT NULL,
      code_id         INTEGER NOT NULL,
      header          BLOB    NOT NULL,
      body            BLOB    NOT NULL,
      runtime         TEXT    NOT NULL,
      is_initial      INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS chain_state (
      id             INTEGER PRIMARY KEY CHECK (id = 1),
      best_hash      TEXT NOT NULL,
      finalized_hash TEXT NOT NULL
    );
  `);

  // ── Prepared statements ──────────────────────────────────────────────────

  const stmtInsertNode = sqlite.prepare(
    `INSERT INTO storage_nodes (hash, val_state, value, exhaustive, children)
     VALUES (?, ?, ?, ?, ?)`
  );
  const stmtUpdateExhaustive = sqlite.prepare(
    `UPDATE storage_nodes SET exhaustive = 1 WHERE id = ?`
  );
  const stmtInsertCode = sqlite.prepare(
    `INSERT OR IGNORE INTO codes (fingerprint, code) VALUES (?, ?)`
  );
  const stmtSelectCodeId = sqlite.prepare(
    `SELECT id FROM codes WHERE fingerprint = ?`
  );
  const stmtUpsertBlock = sqlite.prepare(
    `INSERT INTO blocks (hash, parent_hash, height, storage_root_id, code_id, header, body, runtime, is_initial)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(hash) DO UPDATE SET storage_root_id = excluded.storage_root_id`
  );
  const stmtUpsertChainState = sqlite.prepare(
    `INSERT INTO chain_state (id, best_hash, finalized_hash) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET best_hash = excluded.best_hash, finalized_hash = excluded.finalized_hash`
  );
  const stmtLoadNodes = sqlite.prepare(
    `SELECT id, hash, val_state, value, exhaustive, children FROM storage_nodes ORDER BY id ASC`
  );
  const stmtLoadCodes = sqlite.prepare(`SELECT id, code FROM codes`);
  const stmtLoadBlocks = sqlite.prepare(
    `SELECT hash, parent_hash, height, storage_root_id, code_id, header, body, runtime, is_initial
     FROM blocks ORDER BY height ASC, id ASC`
  );
  const stmtLoadChainState = sqlite.prepare(
    `SELECT best_hash, finalized_hash FROM chain_state`
  );

  // ── In-memory set tracking which node IDs are already exhaustive in DB ───
  const exhaustiveInDb = new Set<number>();

  // ── Encoding helpers ─────────────────────────────────────────────────────

  function encodeChildren(children: Array<StorageNode>): Buffer {
    const buf = Buffer.alloc(64);
    for (let i = 0; i < 16; i++) {
      buf.writeInt32LE(children[i]?.dbId ?? -1, i * 4);
    }
    return buf;
  }

  function decodeChildren(
    buf: Buffer,
    nodeMap: Map<number, StorageNode>
  ): Array<StorageNode> {
    const children = new Array<StorageNode>(16);
    for (let i = 0; i < 16; i++) {
      const id = buf.readInt32LE(i * 4);
      if (id !== -1) children[i] = nodeMap.get(id)!;
    }
    return children;
  }

  function encodeBody(body: Uint8Array[]): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32LE(body.length, 0);
    const parts: Buffer[] = [count];
    for (const item of body) {
      const len = Buffer.alloc(4);
      len.writeUInt32LE(item.length, 0);
      parts.push(len, Buffer.from(item));
    }
    return Buffer.concat(parts);
  }

  function decodeBody(buf: Buffer): Uint8Array[] {
    const count = buf.readUInt32LE(0);
    const result: Uint8Array[] = [];
    let offset = 4;
    for (let i = 0; i < count; i++) {
      const len = buf.readUInt32LE(offset);
      offset += 4;
      result.push(Uint8Array.from(buf.subarray(offset, offset + len)));
      offset += len;
    }
    return result;
  }

  // ── Core node persistence ────────────────────────────────────────────────

  /** Recursively insert new nodes bottom-up. Nodes with a dbId are already in DB. */
  function saveNodes(node: StorageNode): void {
    if (node.dbId != null) return;

    for (const child of node.children) {
      if (child) saveNodes(child);
    }

    let valState: number;
    let valBlob: Buffer | null;
    if (node.value === undefined) {
      valState = 0;
      valBlob = null;
    } else if (node.value === null) {
      valState = 2;
      valBlob = null;
    } else {
      valState = 1;
      valBlob = Buffer.from(node.value);
    }

    const result = stmtInsertNode.run(
      Buffer.from(node.hash),
      valState,
      valBlob,
      node.exhaustive ? 1 : 0,
      encodeChildren(node.children)
    );
    node.dbId = Number(result.lastInsertRowid);
    if (node.exhaustive) exhaustiveInDb.add(node.dbId);
  }

  const saveNodesTx = sqlite.transaction(saveNodes);

  function saveCode(code: Uint8Array): number {
    const fp = Buffer.from(Blake2128(code));
    stmtInsertCode.run(fp, Buffer.from(code));
    return (stmtSelectCodeId.get(fp) as { id: number }).id;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  const saveBlockTx = sqlite.transaction((block: Block, isInitial: boolean) => {
    saveNodes(block.storageRoot);
    const codeId = saveCode(block.code);
    stmtUpsertBlock.run(
      block.hash,
      block.parent,
      block.header.number,
      block.storageRoot.dbId!,
      codeId,
      Buffer.from(blockHeaderCodec.enc(block.header)),
      encodeBody(block.body),
      JSON.stringify(block.runtime),
      isInitial ? 1 : 0
    );
  });

  const markExhaustiveTx = sqlite.transaction((nodes: StorageNode[]) => {
    for (const node of nodes) {
      if (node.dbId != null && !exhaustiveInDb.has(node.dbId)) {
        stmtUpdateExhaustive.run(node.dbId);
        exhaustiveInDb.add(node.dbId);
      }
    }
  });

  return {
    saveBlock(block, isInitial = false) {
      saveBlockTx(block, isInitial);
    },

    saveStorageRoot(root) {
      saveNodesTx(root);
    },

    markExhaustive(nodes) {
      markExhaustiveTx(nodes);
    },

    setChainState(best, finalized) {
      stmtUpsertChainState.run(best, finalized);
    },

    load() {
      const stateRow = stmtLoadChainState.get() as
        | { best_hash: string; finalized_hash: string }
        | undefined;
      if (!stateRow) return null;

      // ── Reconstruct trie nodes ──────────────────────────────────────────
      type NodeRow = {
        id: number;
        hash: Buffer;
        val_state: number;
        value: Buffer | null;
        exhaustive: number;
        children: Buffer;
      };
      const nodeRows = stmtLoadNodes.all() as NodeRow[];
      const nodeMap = new Map<number, StorageNode>();

      for (const row of nodeRows) {
        let value: Uint8Array | null | undefined;
        if (row.val_state === 1) value = new Uint8Array(row.value!);
        else if (row.val_state === 2) value = null;
        // else undefined

        const node: StorageNode = {
          dbId: row.id,
          hash: new Uint8Array(row.hash),
          children: new Array(16), // wired below
          value,
          exhaustive: row.exhaustive === 1,
        };
        if (node.exhaustive) exhaustiveInDb.add(row.id);
        nodeMap.set(row.id, node);
      }

      // Wire children (second pass — all nodes exist in the map now)
      for (const row of nodeRows) {
        nodeMap.get(row.id)!.children = decodeChildren(
          Buffer.from(row.children),
          nodeMap
        );
      }

      // ── Load codes ──────────────────────────────────────────────────────
      type CodeRow = { id: number; code: Buffer };
      const codeMap = new Map<number, Uint8Array>();
      for (const row of stmtLoadCodes.all() as CodeRow[]) {
        codeMap.set(row.id, new Uint8Array(row.code));
      }

      // ── Reconstruct blocks ──────────────────────────────────────────────
      type BlockRow = {
        hash: string;
        parent_hash: string;
        height: number;
        storage_root_id: number;
        code_id: number;
        header: Buffer;
        body: Buffer;
        runtime: string;
        is_initial: number;
      };
      const blockRows = stmtLoadBlocks.all() as BlockRow[];
      if (!blockRows.length) return null;

      const blockMap = new Map<string, Block>();
      let initialBlock: Block | null = null;

      for (const row of blockRows) {
        const block: Block = {
          hash: row.hash as HexString,
          parent: row.parent_hash as HexString,
          code: codeMap.get(row.code_id)!,
          storageRoot: nodeMap.get(row.storage_root_id)!,
          header: blockHeaderCodec.dec(new Uint8Array(row.header)),
          body: decodeBody(Buffer.from(row.body)),
          runtime: JSON.parse(row.runtime) as RuntimeVersion,
          children: [],
        };
        blockMap.set(block.hash, block);
        if (row.is_initial) initialBlock = block;
      }

      if (!initialBlock) return null;

      // Reconstruct children[] on each block from parent_hash relationships
      const nullParent =
        "0x0000000000000000000000000000000000000000000000000000000000000000";
      for (const block of blockMap.values()) {
        if (block.parent !== nullParent) {
          blockMap.get(block.parent)?.children.push(block.hash);
        }
      }

      return {
        initialBlock,
        blocks: Array.from(blockMap.values()),
        best: stateRow.best_hash as HexString,
        finalized: stateRow.finalized_hash as HexString,
      };
    },

    close() {
      sqlite.close();
    },
  };
}
