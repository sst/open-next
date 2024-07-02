import { readFileSync } from "node:fs";

import { Plugin } from "esbuild";
import type {
  DefaultOverrideOptions,
  ImageLoader,
  IncludedImageLoader,
  LazyLoadedOverride,
  OverrideOptions,
} from "types/open-next";

import logger from "../logger.js";
import path from "path";
import escapeStringRegexp from 'escape-string-regexp';

export interface IPluginSettings {
  overrides?: {
    wrapper?: DefaultOverrideOptions<any, any>["wrapper"];
    converter?: DefaultOverrideOptions<any, any>["converter"];
    tagCache?: OverrideOptions["tagCache"];
    queue?: OverrideOptions["queue"];
    incrementalCache?: OverrideOptions["incrementalCache"];
    imageLoader?: LazyLoadedOverride<ImageLoader> | IncludedImageLoader;
  };
  fnName?: string;
}

function getOverrideOrDefault<
  Override extends string | LazyLoadedOverride<any>,
>(override: Override, defaultOverride: string) {
  if (typeof override === "string") {
    return override;
  }
  return defaultOverride;
}

/**
 * @param opts.overrides - The name of the overrides to use
 * @returns
 */
export function openNextResolvePlugin({
  overrides,
  fnName,
}: IPluginSettings): Plugin {
  return {
    name: "opennext-resolve",
    setup(build) {
      logger.debug(`OpenNext Resolve plugin for ${fnName}`);
      const filter = new RegExp(
        escapeStringRegexp(path.join("core", "resolve.js")),
        "g",
      );
      build.onLoad({ filter }, async (args) => {
        let contents = readFileSync(args.path, "utf-8");
        //TODO: refactor this. Every override should be at the same place so we can generate this dynamically
        if (overrides?.wrapper) {
          contents = contents.replace(
            "../wrappers/aws-lambda.js",
            `../wrappers/${getOverrideOrDefault(
              overrides.wrapper,
              "aws-lambda",
            )}.js`,
          );
        }
        if (overrides?.converter) {
          contents = contents.replace(
            "../converters/aws-apigw-v2.js",
            `../converters/${getOverrideOrDefault(
              overrides.converter,
              "dummy",
            )}.js`,
          );
        }
        if (overrides?.tagCache) {
          contents = contents.replace(
            "../cache/tag/dynamodb.js",
            `../cache/tag/${getOverrideOrDefault(
              overrides.tagCache,
              "dynamodb-lite",
            )}.js`,
          );
        }
        if (overrides?.queue) {
          contents = contents.replace(
            "../queue/sqs.js",
            `../queue/${getOverrideOrDefault(overrides.queue, "sqs-lite")}.js`,
          );
        }
        if (overrides?.incrementalCache) {
          contents = contents.replace(
            "../cache/incremental/s3.js",
            `../cache/incremental/${getOverrideOrDefault(
              overrides.incrementalCache,
              "s3-lite",
            )}.js`,
          );
        }
        if (overrides?.imageLoader) {
          contents = contents.replace(
            "../overrides/imageLoader/s3.js",
            `../overrides/imageLoader/${getOverrideOrDefault(
              overrides.imageLoader,
              "s3",
            )}.js`,
          );
        }
        return {
          contents,
        };
      });
    },
  };
}
