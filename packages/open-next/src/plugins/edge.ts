import { readFileSync } from "node:fs";

import { Plugin } from "esbuild";

import {
  loadAppPathsManifestKeys,
  loadBuildId,
  loadConfig,
  loadConfigHeaders,
  loadHtmlPages,
  loadMiddlewareManifest,
  loadPrerenderManifest,
  loadRoutesManifest,
} from "../adapters/config/util.js";

export interface IPluginSettings {
  nextDir: string;
  edgeFunctionHandlerPath?: string;
  entryFiles: string[];
}

/**
 * TODO: Handle wasm import
 * @param opts.nextDir - The path to the .next directory
 * @param opts.edgeFunctionHandlerPath - The path to the edgeFunctionHandler.js file that we'll use to bundle the routing
 * @param opts.entryFiles - The entry files that we'll inject into the edgeFunctionHandler.js file
 * @returns
 */
export function openNextEdgePlugins({
  nextDir,
  edgeFunctionHandlerPath,
  entryFiles,
}: IPluginSettings): Plugin {
  return {
    name: "opennext-edge",
    setup(build) {
      if (edgeFunctionHandlerPath) {
        // If we bundle the routing, we need to resolve the middleware
        build.onResolve({ filter: /\.\/middleware.mjs/g }, () => {
          return {
            path: edgeFunctionHandlerPath,
          };
        });
      }

      // We inject the entry files into the edgeFunctionHandler
      build.onLoad({ filter: /\/edgeFunctionHandler.js/g }, async (args) => {
        let contents = readFileSync(args.path, "utf-8");
        contents = `
globalThis._ENTRIES = {};
globalThis.self = globalThis;
globalThis.process = {env: {}}

import {Buffer} from "node:buffer";
globalThis.Buffer = Buffer;

import {AsyncLocalStorage} from "node:async_hooks";
globalThis.AsyncLocalStorage = AsyncLocalStorage;
${entryFiles?.map((file) => `require("${file}");`).join("\n")}
${contents}        
        `;
        return {
          contents,
        };
      });

      build.onLoad({ filter: /adapters\/config\/index.ts/g }, async () => {
        console.log("opennext-config-plugin");
        const NextConfig = loadConfig(nextDir);
        const BuildId = loadBuildId(nextDir);
        const HtmlPages = loadHtmlPages(nextDir);
        const RoutesManifest = loadRoutesManifest(nextDir);
        const ConfigHeaders = loadConfigHeaders(nextDir);
        const PrerenderManifest = loadPrerenderManifest(nextDir);
        const AppPathsManifestKeys = loadAppPathsManifestKeys(nextDir);
        const MiddlewareManifest = loadMiddlewareManifest(nextDir);

        const contents = `
  import path from "path";
  
  import { debug } from "../logger";
  
  if(!globalThis.__dirname) {
    globalThis.__dirname = ""
  }
  
  export const NEXT_DIR = path.join(__dirname, ".next");
  export const OPEN_NEXT_DIR = path.join(__dirname, ".open-next");
  
  debug({ NEXT_DIR, OPEN_NEXT_DIR });
  
  export const NextConfig = ${JSON.stringify(NextConfig)};
  export const BuildId = ${JSON.stringify(BuildId)};
  export const HtmlPages = ${JSON.stringify(HtmlPages)};
  export const RoutesManifest = ${JSON.stringify(RoutesManifest)};
  export const ConfigHeaders = ${JSON.stringify(ConfigHeaders)};
  export const PrerenderManifest = ${JSON.stringify(PrerenderManifest)};
  export const AppPathsManifestKeys = ${JSON.stringify(AppPathsManifestKeys)};
  export const MiddlewareManifest = ${JSON.stringify(MiddlewareManifest)};
  
          `;
        return {
          contents,
        };
      });
    },
  };
}
