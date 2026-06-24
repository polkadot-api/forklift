import { chmodSync, statSync } from "fs";
import path from "path";
import { build as esbuildBuild } from "esbuild";
import dts from "rollup-plugin-dts";
import esbuild from "rollup-plugin-esbuild";

const commonOptions = {
  input: "src/index.ts",
  external: (id) => !/^[./]/.test(id) && !/^@\//.test(id),
};

const srcIndexId = path.resolve("src/index.ts");

const workerBundle = () => ({
  name: "worker-bundle",
  async writeBundle() {
    await esbuildBuild({
      entryPoints: ["src/executor/executor-worker.ts"],
      outfile: "dist/worker.js",
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2020",
      sourcemap: true,
    });
  },
});

export default [
  {
    ...commonOptions,
    plugins: [esbuild(), workerBundle()],
    output: [
      {
        dir: `dist`,
        format: "es",
        sourcemap: true,
        preserveModules: true,
      },
    ],
  },
  {
    ...commonOptions,
    input: "src/index.ts",
    plugins: [dts()],
    output: {
      file: `dist/index.d.ts`,
      format: "es",
    },
  },
  {
    input: "cli/cli.ts",
    external: (id, _parent, isResolved) =>
      (isResolved && id === srcIndexId) ||
      (!/^[./]/.test(id) && !/^@\//.test(id)),
    plugins: [
      esbuild(),
      {
        // seems rollup-plugin-executable is not compatible with latest rollup version.
        writeBundle(options, entries) {
          Object.values(entries)
            .filter((v) => v.fileName.endsWith("js"))
            .forEach((v) => {
              const file = path.join(options.dir, v.fileName);
              chmodSync(file, statSync(file).mode | 0o111);
            });
        },
      },
    ],
    output: {
      dir: `bin`,
      format: "es",
      sourcemap: true,
      entryFileNames: "[name].js",
      banner: "#!/usr/bin/env node",
      paths: (id) => (id === srcIndexId ? "../dist/src/index.js" : id),
    },
  },
];
