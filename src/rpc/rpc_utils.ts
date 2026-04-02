import type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
} from "@polkadot-api/substrate-client";
import { Subscription, type Observable } from "rxjs";
import type { Chain } from "../chain";
import type { HexString } from "polkadot-api";

export interface Connection {
  disconnect$: Observable<void>;
  send: (msg: JsonRpcMessage) => void;
  context: {
    chainHead_v1_subs: Record<
      string,
      {
        pinnedBlocks: Set<string>;
        storageOps: Record<
          string,
          {
            hash: HexString;
            items: Array<{
              key: HexString;
              type:
                | "value"
                | "hash"
                | "closestDescendantMerkleValue"
                | "descendantsValues"
                | "descendantsHashes";
            }>;
            childTrie: HexString | null;
            subscription: Subscription;
          }
        >;
      }
    >;
  };
}

export type RpcMethod = (
  chain: Chain,
  con: Connection,
  req: JsonRpcRequest
) => void;

export const getParams = <T>(req: JsonRpcRequest<T>, params: string[]): T =>
  Array.isArray(req.params)
    ? (Object.fromEntries(
        params.map((key, i) => [key, (req.params as any)[i]])
      ) as T)
    : req.params!;

let uuid = 0;
export const getUuid = () => `${uuid++}`;

export const respond = (req: JsonRpcRequest, result: any): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id: req.id!,
  result,
});
