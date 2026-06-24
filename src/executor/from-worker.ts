import { proxy, wrap } from "comlink";
import type {
  Executor,
  RuntimeCallParams,
  RuntimeCallResult,
} from "./interface";

type WorkerRuntimeCallParams = Omit<RuntimeCallParams, "storage"> & {
  code: Uint8Array;
};

type RuntimeCallStorage = Pick<
  RuntimeCallParams["storage"],
  "getValue" | "getDescendantKeys"
>;

// Comlink needs all functions into one argument, otherwise it promisifies everything.
type WorkerExecutor = Omit<Executor, "runRuntimeCall"> & {
  runRuntimeCall(
    params: WorkerRuntimeCallParams,
    storage: RuntimeCallStorage
  ): Promise<RuntimeCallResult>;
};

export const fromWorker = (worker: Worker): Executor => {
  const wrapped = wrap<WorkerExecutor>(worker);
  return {
    createProof(nodes, updates) {
      return wrapped.createProof(nodes, updates);
    },
    decodeProof(trieRootHash, nodes) {
      return wrapped.decodeProof(trieRootHash, nodes);
    },
    getRuntimeVersion(code) {
      return wrapped.getRuntimeVersion(code);
    },
    runRuntimeCall(params) {
      const { storage, ...rest } = params;

      return wrapped.runRuntimeCall(
        {
          ...rest,
          code: storage.code,
        },
        proxy({
          getValue: (key) => storage.getValue(key),
          getDescendantKeys: (prefix) => storage.getDescendantKeys(prefix),
        })
      );
    },
  };
};
