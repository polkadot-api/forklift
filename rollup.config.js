import { chmodSync, statSync } from "fs";
import path from "path";
import dts from "rollup-plugin-dts";
import esbuild from "rollup-plugin-esbuild";

const commonOptions = {
  input: "src/index.ts",
  external: (id) => !/^[./]/.test(id) && !/^@\//.test(id),
};

const srcIndexId = path.resolve("src/index.ts");

export default [
  {
    ...commonOptions,
    plugins: [esbuild()],
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
    plugins: [dts()],
    output: {
      file: `dist/index.d.ts`,
      format: "es",
    },
  },
  {
    input: "cli.ts",
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
      paths: (id) => (id === srcIndexId ? "../dist/index.js" : id),
    },
  },
];
