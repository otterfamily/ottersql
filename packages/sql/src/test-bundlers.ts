import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runInBun } from "@ottersql/testing";
import { build as esbuild } from "esbuild";
import { build as vite } from "vite";
import webpack from "webpack";

import { ottersql as esbuildPlugin } from "./esbuild.ts";
import { ottersql as vitePlugin } from "./vite.ts";

/** The file every bundler writes in `dist`, an ES module re-exporting the queries of `main.js`. */
export const OUTPUT = "main.mjs";

async function bundleWithVite(root: string): Promise<void> {
  await vite({
    root,
    logLevel: "silent",
    configFile: false,
    plugins: [vitePlugin()],
    build: { ssr: "main.js", outDir: "dist" },
  });
}

async function bundleWithEsbuild(root: string): Promise<void> {
  await esbuild({
    entryPoints: [join(root, "main.js")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: join(root, "dist", OUTPUT),
    plugins: [esbuildPlugin()],
    logLevel: "silent",
  });
}

async function bundleWithWebpack(root: string): Promise<void> {
  const compiler = webpack({
    mode: "none",
    target: "node",
    context: root,
    entry: "./main.js",
    experiments: { outputModule: true },
    output: { path: join(root, "dist"), filename: OUTPUT, library: { type: "module" } },
    module: {
      rules: [
        { test: /\.sql$/v, loader: fileURLToPath(import.meta.resolve("./webpack.ts")) },
        {
          test: /\.ts$/v,
          loader: fileURLToPath(import.meta.resolve("./test-typescript-loader.ts")),
        },
      ],
    },
  });
  const stats = await promisify(compiler.run.bind(compiler))();
  if (stats?.hasErrors() === true) {
    throw new Error(stats.toString("errors-only"));
  }
}

async function bundleWithBun(root: string): Promise<void> {
  const script = [
    `import { ottersql } from ${JSON.stringify(fileURLToPath(import.meta.resolve("./esbuild.ts")))};`,
    "const result = await Bun.build({",
    `  entrypoints: ["main.js"], outdir: "dist", naming: "${OUTPUT}", target: "node",`,
    "  plugins: [ottersql()],",
    "});",
    String.raw`if (!result.success) { console.error(result.logs.join("\n")); process.exit(1); }`,
  ].join("\n");
  await runInBun(script, root);
}

/** Each bundler ottersql supports, bundling `main.js` in a directory into `dist/main.mjs`. */
export const bundlers: readonly {
  readonly name: string;
  readonly bundle: (root: string) => Promise<void>;
}[] = [
  { name: "Vite", bundle: bundleWithVite },
  { name: "esbuild", bundle: bundleWithEsbuild },
  { name: "webpack", bundle: bundleWithWebpack },
  { name: "Bun.build", bundle: bundleWithBun },
];
