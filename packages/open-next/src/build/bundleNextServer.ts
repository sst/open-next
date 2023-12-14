import { createRequire as topLevelCreateRequire } from "node:module";

import { build } from "esbuild";
import path from "path";

const externals = [
  // This one was causing trouble, don't know why
  "../experimental/testmode/server",

  // sharedExternals
  "styled-jsx",
  "styled-jsx/style",
  "@opentelemetry/api",
  "next/dist/compiled/@next/react-dev-overlay/dist/middleware",
  "next/dist/compiled/@ampproject/toolbox-optimizer",
  "next/dist/compiled/edge-runtime",
  "next/dist/compiled/@edge-runtime/ponyfill",
  "next/dist/compiled/undici",
  "next/dist/compiled/raw-body",
  "next/dist/server/capsize-font-metrics.json",
  "critters",
  "next/dist/compiled/node-html-parser",
  "next/dist/compiled/compression",
  "next/dist/compiled/jsonwebtoken",
  "next/dist/compiled/@opentelemetry/api",
  "next/dist/compiled/@mswjs/interceptors/ClientRequest",
  "next/dist/compiled/ws",

  // externalsMap
  // In the config they replace it, but we don't use this one inside NextServer anymore 13.4.12+
  // For earlier versions we might have to alias it
  "./web/sandbox",

  // pagesExternal
  "react",
  "react-dom",
  "react-server-dom-webpack",
  "react-server-dom-turbopack",

  // We need to remove this since this is what webpack is building
  // Adding it cause to add a lot of unnecessary deps
  "next/dist/compiled/next-server",
];

export async function bundleNextServer(outputDir: string, appPath: string) {
  const require = topLevelCreateRequire(`${appPath}/package.json`);
  const entrypoint = require.resolve("next/dist/esm/server/next-server.js");

  await build({
    entryPoints: [entrypoint],
    bundle: true,
    platform: "node",
    target: ["node18"],
    // packages: "external",
    format: "cjs",
    external: externals,
    minify: true,
    outfile: path.join(outputDir, "next-server.runtime.prod.js"),
    sourcemap: false,
    plugins: [
      {
        name: "opennext-next-server",
        setup(build) {
          // This was an attempt at reducing server bundle size
          // It might be the better way to go in the future
          build.onResolve({ filter: /\.\/module.compiled/ }, (args) => {
            const dir = args.resolveDir.split("/").slice(-1);
            return {
              path: path.join(
                "next/dist/compiled/next-server/",
                `${dir}.runtime.prod.js`,
              ),
              external: true,
            };
          });

          build.onResolve({ filter: /[\\/]react-server\.node/ }, (args) => {
            return {
              path: args.path,
              external: true,
            };
          });

          build.onResolve(
            { filter: /vendored[\\/]rsc[\\/]entrypoints/ },
            (args) => {
              return {
                path: args.path,
                external: true,
              };
            },
          );

          build.onResolve({ filter: /\.external/ }, (args) => {
            return {
              path: args.path.replace(/\.\./, "next/dist"),
              external: true,
            };
          });
        },
      },
    ],
  });
}
