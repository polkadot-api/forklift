import { expose } from "comlink";
import { executor } from "./executor";
import type { RuntimeCallParams } from "./interface";

type WorkerRuntimeCallParams = Omit<RuntimeCallParams, "storage"> & {
  code: Uint8Array;
};

type RuntimeCallStorage = Pick<
  RuntimeCallParams["storage"],
  "getValue" | "getDescendantKeys"
>;

expose({
  ...executor,
  runRuntimeCall(
    { code, ...params }: WorkerRuntimeCallParams,
    storage: RuntimeCallStorage
  ) {
    return executor.runRuntimeCall({
      ...params,
      storage: {
        code,
        getValue: storage.getValue,
        getDescendantKeys: storage.getDescendantKeys,
      },
    });
  },
});
