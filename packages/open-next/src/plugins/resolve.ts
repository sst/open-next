import { readFileSync } from "node:fs";

import { Plugin } from "esbuild";
import type {
  IncludedConverter,
  IncludedIncrementalCache,
  IncludedQueue,
  IncludedTagCache,
  IncludedWrapper,
} from "types/open-next";

export interface IPluginSettings {
  overrides: {
    wrapper?: IncludedWrapper;
    converter?: IncludedConverter;
    // Right now theses do nothing since there is only one implementation
    tag?: IncludedTagCache;
    queue?: IncludedQueue;
    incrementalCache?: IncludedIncrementalCache;
  };
}

/**
 * @param opts.overrides - The name of the overrides to use
 * @returns
 */
export function openNextResolvePlugin({ overrides }: IPluginSettings): Plugin {
  return {
    name: "opennext-resolve",
    setup(build) {
      build.onLoad({ filter: /core\/resolve.js/g }, async (args) => {
        let contents = readFileSync(args.path, "utf-8");
        if (overrides?.wrapper) {
          contents = contents.replace(
            "../wrappers/aws-lambda.js",
            `../wrappers/${overrides.wrapper}.js`,
          );
        }
        if (overrides?.converter) {
          contents = contents.replace(
            "../converters/aws-apigw-v2.js",
            `../converters/${overrides.converter}.js`,
          );
        }
        return {
          contents,
        };
      });
    },
  };
}
