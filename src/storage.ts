import { Blake2128 } from "@polkadot-api/substrate-bindings";

const TRIE_SIZE = 16;
export interface StorageNode {
  hash: Uint8Array;
  children: Array<StorageNode>; // nibble -> node
  value?: Uint8Array | null;
  exhaustive?: boolean;
}

const emptyHashBin = Blake2128(new Uint8Array());
const emptyHash = Array.from(emptyHashBin);
const getHash = (children: Array<StorageNode>, value?: Uint8Array | null) => {
  if (!value) {
    const realChildren = children.filter((v) => !!v);
    if (realChildren.length === 0) return emptyHashBin;
    if (realChildren.length === 1) return realChildren[0]!.hash;
  }
  const childHashes = new Array(TRIE_SIZE)
    .fill(0)
    .flatMap((_, i) =>
      children[i] ? Array.from(children[i].hash) : emptyHash
    );

  return Blake2128(
    new Uint8Array([
      ...childHashes,
      value ? 1 : 0,
      ...(value ?? new Uint8Array()),
    ])
  );
};
const getNibble = (key: Uint8Array, offset: number) => {
  const byte = key[Math.floor(offset / 2)];
  if (byte == null) return null;
  return offset % 2 === 0 ? byte >> 4 : byte & 0x0f;
};
const setNibble = (key: Uint8Array, offset: number, value: number) =>
  offset % 2 === 0
    ? new Uint8Array([...key, value << 4])
    : new Uint8Array(key.map((v, j) => (j === key.length - 1 ? v | value : v)));

export const createRoot = (): StorageNode => {
  const children = new Array(TRIE_SIZE);
  return {
    hash: getHash(children),
    children,
  };
};

export const insertValue = (
  root: StorageNode,
  key: Uint8Array,
  nibbles: number,
  value: Uint8Array | null,
  offset = 0
): StorageNode => {
  if (nibbles === offset)
    return {
      ...root,
      value,
    };

  const nibble = getNibble(key, offset);
  if (nibble == null) throw new Error("Key overflow");

  const child = root.children[nibble];
  if (!child) {
    const children = [...root.children];
    children[nibble] = createNodeValue(key, nibbles, value, offset + 1);
    return {
      hash: getHash(children, root.value),
      children,
      value: root.value,
      exhaustive: root.exhaustive,
    };
  }

  const children = [...root.children];
  children[nibble] = insertValue(child, key, nibbles, value, offset + 1);
  return {
    hash: getHash(children, root.value),
    children,
    value: root.value,
    exhaustive: root.exhaustive,
  };
};

const createNodeValue = (
  key: Uint8Array,
  nibbles: number,
  value: Uint8Array | null,
  offset: number
): StorageNode => {
  if (nibbles === offset)
    return {
      hash: getHash([], value),
      children: new Array(TRIE_SIZE),
      value,
    };
  const nibble = getNibble(key, offset);
  if (nibble == null) throw new Error("Key overflow");

  const child = createNodeValue(key, nibbles, value, offset + 1);
  const children = new Array(TRIE_SIZE);
  children[nibble] = child;
  return {
    hash: getHash(children),
    children,
  };
};

export const deleteValue = (
  root: StorageNode,
  key: Uint8Array,
  nibbles: number,
  offset = 0
): StorageNode => {
  if (offset === nibbles)
    return root.value
      ? {
          ...root,
          // Soft delete to have it marked as removed, otherwise we'd go back to the source
          value: null,
        }
      : root;
  const nibble = getNibble(key, offset);
  if (nibble == null) throw new Error("Key overflow");

  const child = root.children[nibble];
  if (!child) return root;

  const newChild = deleteValue(child, key, offset + 1);
  if (newChild === child) return root;

  const children = [...root.children];
  children[nibble] = newChild;
  return {
    hash: getHash(children, root.value),
    children,
    value: root.value,
    exhaustive: root.exhaustive,
  };
};

export const getNode = (
  root: StorageNode,
  key: Uint8Array,
  nibbles: number,
  offset = 0
): StorageNode | null => {
  if (offset === nibbles) return root;
  const nibble = getNibble(key, offset);
  if (nibble == null) throw new Error("Key overflow");

  const child = root.children[nibble];
  if (!child) return null;

  return getNode(child, key, nibbles, offset + 1);
};

export const getDiff = (
  base: StorageNode,
  other: StorageNode,
  prefix = new Uint8Array(),
  nibbles = 0
): {
  insert: StorageNode;
  deleteNodes: Array<{ key: Uint8Array; nibbles: number }>;
  deleteValues: Array<{ key: Uint8Array; nibbles: number }>;
} => {
  const children = new Array<StorageNode>(TRIE_SIZE);
  let deleteNodes = new Array<{ key: Uint8Array; nibbles: number }>();
  let deleteValues = new Array<{ key: Uint8Array; nibbles: number }>();

  for (let i = 0; i < TRIE_SIZE; i++) {
    const baseNode = base.children[i];
    const otherNode = other.children[i];
    const childPrefix = setNibble(prefix, nibbles, i);

    if (otherNode) {
      if (baseNode) {
        if (otherNode.hash === baseNode.hash) continue;

        const childDiff = getDiff(
          baseNode,
          otherNode,
          childPrefix,
          nibbles + 1
        );
        children[i] = childDiff.insert;
        deleteNodes = [...deleteNodes, ...childDiff.deleteNodes];
        deleteValues = [...deleteValues, ...childDiff.deleteValues];
      } else {
        children[i] = otherNode;
      }
    } else {
      if (baseNode) {
        deleteNodes.push({ key: prefix, nibbles: nibbles + 1 });
      }
    }
  }

  let value: Uint8Array | undefined;
  if (other.value) {
    if (!base.value || (base.value && !arrU8Eq(base.value, other.value))) {
      value = other.value;
    }
  } else if (base.value) {
    deleteValues.push({
      key: prefix,
      nibbles,
    });
  }

  return {
    insert: {
      hash: getHash(children, value),
      children,
      value,
    },
    deleteNodes,
    deleteValues,
  };
};

export const getDescendantValues = (
  node: StorageNode,
  prefix: Uint8Array,
  nibbles: number
): Array<{ key: Uint8Array; nibbles: number; value: Uint8Array }> => {
  let result = new Array<{
    key: Uint8Array;
    nibbles: number;
    value: Uint8Array;
  }>();
  if (node.value) {
    result.push({ key: prefix, nibbles, value: node.value });
  }

  node.children.forEach((child, i) => {
    const childPrefix = setNibble(prefix, nibbles, i);
    result = [
      ...result,
      ...getDescendantValues(child, childPrefix, nibbles + 1),
    ];
  });
  return result;
};

export const forEachDescendant = (
  root: StorageNode,
  cb: (node: StorageNode) => void
) => {
  root.children.forEach((child) => {
    cb(child);
    forEachDescendant(child, cb);
  });
};

const arrU8Eq = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => b[i] === v);
