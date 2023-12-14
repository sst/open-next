import url from "node:url";

import fs from "fs";
import path from "path";
import { MiddlewareManifest } from "types/next-types";
import { BuildOptions, IncludedConverter } from "types/open-next";

import { openNextEdgePlugins } from "../../plugins/edge.js";
import { openNextResolvePlugin } from "../../plugins/resolve.js";
import { esbuildAsync, Options } from "../helper.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

interface BuildEdgeBundleOptions {
  appBuildOutputPath: string;
  files: string[];
  routes: {
    name: string;
    page: string;
    regex: string[];
  }[];
  entrypoint: string;
  outfile: string;
  options: Options;
  defaultConverter?: IncludedConverter;
  additionalInject?: string;
}

export async function buildEdgeBundle({
  appBuildOutputPath,
  files,
  routes,
  entrypoint,
  outfile,
  options,
  defaultConverter,
  additionalInject,
}: BuildEdgeBundleOptions) {
  await esbuildAsync(
    {
      entryPoints: [entrypoint],
      // inject: ,
      bundle: true,
      outfile,
      external: ["node:*", "next", "@aws-sdk/*"],
      target: "es2022",
      platform: "neutral",
      plugins: [
        openNextResolvePlugin({
          overrides: {
            wrapper: "aws-lambda",
            converter: defaultConverter,
          },
        }),
        openNextEdgePlugins({
          entryFiles: files.map((file: string) =>
            path.join(appBuildOutputPath, ".next", file),
          ),
          routes,
          nextDir: path.join(appBuildOutputPath, ".next"),
          edgeFunctionHandlerPath: path.join(
            __dirname,
            "../../core",
            "edgeFunctionHandler.js",
          ),
        }),
      ],
      treeShaking: true,
      alias: {
        path: "node:path",
        stream: "node:stream",
        fs: "node:fs",
      },
      conditions: ["module"],
      mainFields: ["module", "main"],
      banner: {
        js: `
  const require = (await import("node:module")).createRequire(import.meta.url);
  const __filename = (await import("node:url")).fileURLToPath(import.meta.url);
  const __dirname = (await import("node:path")).dirname(__filename);
  ${additionalInject ?? ""}
  `,
      },
    },
    options,
  );
}

export async function generateEdgeBundle(
  name: string,
  options: Options,
  fnOptions: BuildOptions["functions"][string],
) {
  const { appBuildOutputPath, outputDir } = options;

  // Create output folder
  const outputPath = path.join(outputDir, "server-functions", name);
  fs.mkdirSync(outputPath, { recursive: true });

  // Copy open-next.config.js
  fs.copyFileSync(
    path.join(outputDir, ".build", "open-next.config.js"),
    path.join(outputPath, "open-next.config.js"),
  );

  // Load middleware manifest
  const middlewareManifest = JSON.parse(
    fs.readFileSync(
      path.join(appBuildOutputPath, ".next/server/middleware-manifest.json"),
      "utf8",
    ),
  ) as MiddlewareManifest;

  // Find functions
  const functions = Object.values(middlewareManifest.functions).filter((fn) =>
    fnOptions.routes.includes(fn.name),
  );

  if (functions.length > 1) {
    throw new Error("Only one function is supported for now");
  }
  const fn = functions[0];

  await buildEdgeBundle({
    appBuildOutputPath,
    files: fn.files,
    routes: [
      {
        name: fn.name,
        page: fn.page,
        regex: fn.matchers.map((m) => m.regexp),
      },
    ],
    entrypoint: path.join(__dirname, "../../adapters", "edge-adapter.js"),
    outfile: path.join(outputPath, "index.mjs"),
    options,
  });
}
