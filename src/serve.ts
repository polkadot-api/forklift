import type {
  JsonRpcMessage,
  JsonRpcProvider,
  JsonRpcRequest,
} from "@polkadot-api/substrate-client";
import {
  combineLatest,
  firstValueFrom,
  pairwise,
  skip,
  Subject,
  Subscription,
  withLatestFrom,
  type Observable,
} from "rxjs";
import type { Chain, HexString } from "./chain";

interface Connection {
  disconnect$: Observable<void>;
  send: (msg: JsonRpcMessage) => void;
}

const getParams = <T>(req: JsonRpcRequest<T>, params: string[]): T =>
  Array.isArray(req.params)
    ? (Object.fromEntries(
        params.map((key, i) => [key, (req.params as any)[i]])
      ) as T)
    : req.params!;

const followEvent = (subscription: string, result: any): JsonRpcMessage => ({
  jsonrpc: "2.0",
  method: "chainHead_v1_followEvent",
  params: {
    subscription,
    result,
  },
});

let uuid = 0;
const getUuid = () => `${uuid++}`;
const methods: Record<
  string,
  (chain: Chain, con: Connection, req: JsonRpcRequest) => void
> = {
  chainHead_v1_follow: async (
    chain: Chain,
    con: Connection,
    req: JsonRpcRequest<{
      withRuntime: boolean;
    }>
  ) => {
    const { withRuntime } = getParams(req, ["withRuntime"]);

    const subId = getUuid();
    con.send({
      jsonrpc: "2.0",
      id: req.id!,
      result: subId,
    });

    const [finalized, blocks] = await firstValueFrom(
      combineLatest([chain.finalized$, chain.blocks$])
    );

    const finalizedBlockHashes = [finalized];
    let block = finalized;
    for (let i = 0; i < 5 && blocks[block]?.parent! in blocks; i++) {
      block = blocks[block]!.parent;
      finalizedBlockHashes.push(block);
    }
    finalizedBlockHashes.reverse();
    con.send(
      followEvent(subId, {
        event: "initialized",
        finalizedBlockHashes,
        finalizedBlockRuntime: withRuntime
          ? blocks[finalized]!.runtime
          : undefined,
      })
    );

    const sendChildren = (hash: HexString) => {
      const block = blocks[hash]!;
      for (const child of block.children) {
        const childBlock = blocks[child];
        if (!childBlock) {
          console.error("Child block not found", { parent: hash, child });
          continue;
        }
        con.send(
          followEvent(subId, {
            event: "newBlock",
            blockHash: child,
            parentBlockHash: hash,
            newRuntime: childBlock.hasNewRuntime,
          })
        );
        sendChildren(child);
      }
    };
    sendChildren(finalized);

    const subscription = new Subscription();
    subscription.add(
      con.disconnect$.subscribe(() => subscription.unsubscribe())
    );

    subscription.add(
      chain.newBlocks$
        .pipe(withLatestFrom(chain.blocks$))
        .subscribe(([blockHash, blocks]) => {
          const block = blocks[blockHash]!;
          con.send(
            followEvent(subId, {
              event: "newBlock",
              blockHash,
              parentBlockHash: block.parent,
              newRuntime:
                withRuntime && block.hasNewRuntime ? block.runtime : undefined,
            })
          );
        })
    );
    subscription.add(
      chain.best$.subscribe((bestBlockHash) => {
        con.send(
          followEvent(subId, { event: "bestBlockChanged", bestBlockHash })
        );
      })
    );
    subscription.add(
      chain.finalized$
        .pipe(pairwise(), withLatestFrom(chain.blocks$))
        .subscribe(([[prev, next], blocks]) => {
          const finalizedBlockHashes = [next];
          let blockHash = next;
          while (
            blocks[blockHash]?.parent !== prev &&
            blocks[blockHash]?.parent! in blocks
          ) {
            blockHash = blocks[blockHash]!.parent;
            finalizedBlockHashes.push(blockHash);
          }
          finalizedBlockHashes.reverse();

          const prunedBlockHashes: HexString[] = [];
          const pruneBranch = (hash: HexString) => {
            const block = blocks[hash];
            if (!block) return;
            prunedBlockHashes.push(hash);
            block.children.forEach(pruneBranch);
          };

          let i = 0;
          blockHash = prev;
          while (blockHash !== next) {
            const block = blocks[blockHash]!;
            for (const child of block.children) {
              if (child === finalizedBlockHashes[i]) continue;
              pruneBranch(child);
            }
            blockHash = finalizedBlockHashes[i]!;
            i++;
          }

          con.send(
            followEvent(subId, {
              event: "finalized",
              finalizedBlockHashes,
              prunedBlockHashes,
            })
          );
        })
    );
  },
};

export const createServer = (chain: Promise<Chain>): JsonRpcProvider => {
  return (send) => {
    const disconnect = new Subject<void>();
    const con: Connection = {
      send,
      disconnect$: disconnect.asObservable(),
    };

    return {
      disconnect() {},
      async send(req) {
        if (req.method === "rpc_methods") {
          return send({
            jsonrpc: "2.0",
            id: req.id!,
            result: Object.keys(methods),
          });
        }

        const method = methods[req.method];
        if (method) {
          method(await chain, con, req);
        } else {
          send({
            jsonrpc: "2.0",
            id: req.id!,
            error: {
              code: -32601,
              message: "Method not found",
            },
          });
        }
      },
    };
  };
};
