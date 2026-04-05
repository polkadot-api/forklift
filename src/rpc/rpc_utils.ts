import type {
  JsonRpcError,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
} from "@polkadot-api/substrate-client";
import { Subscription, type Observable } from "rxjs";
import type { Chain } from "../chain";
import type { TxPool } from "../txPool";
import type { Source } from "../source";
import type { Forklift } from "../forklift";

export interface Connection {
  disconnect$: Observable<void>;
  send: (msg: JsonRpcMessage) => void;
  context: {
    chainHead_v1_subs: Record<
      string,
      {
        pinnedBlocks: Set<string>;
        operations: Record<string, Subscription>;
      }
    >;
  };
}

export type ServerContext = {
  source: Source;
  chain: Chain;
  txPool: TxPool;
  newBlock: Forklift["newBlock"];
};

export type RpcMethod<T = any> = (
  con: Connection,
  req: JsonRpcRequest<T>,
  ctx: ServerContext
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

export const errorResponse = (
  req: JsonRpcRequest,
  error: JsonRpcError
): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id: req.id!,
  error,
});
