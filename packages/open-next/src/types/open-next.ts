import type { Readable } from "node:stream";

import { StreamCreator } from "http/index.js";

import { WarmerEvent, WarmerResponse } from "../adapters/warmer-function";
import { IncrementalCache } from "../cache/incremental/types";
import { TagCache } from "../cache/tag/types";
import { Queue } from "../queue/types";

export type BaseEventOrResult<T extends string = string> = {
  type: T;
};

export type InternalEvent = {
  readonly method: string;
  readonly rawPath: string;
  readonly url: string;
  readonly body?: Buffer;
  readonly headers: Record<string, string>;
  readonly query: Record<string, string | string[]>;
  readonly cookies: Record<string, string>;
  readonly remoteAddress: string;
} & BaseEventOrResult<"core">;

export type InternalResult = {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  isBase64Encoded: boolean;
} & BaseEventOrResult<"core">;

export interface DangerousOptions {
  /**
   * The dynamo db cache is used for revalidateTags and revalidatePath.
   * @default false
   */
  disableDynamoDBCache?: boolean;
  /**
   * The incremental cache is used for ISR and SSG.
   * Disable this only if you use only SSR
   * @default false
   */
  disableIncrementalCache?: boolean;
}

export type LazyLoadedOverride<T> = () => Promise<T>;

export type OpenNextHandler<
  E extends BaseEventOrResult = InternalEvent,
  R extends BaseEventOrResult = InternalResult,
> = (event: E, responseStream?: StreamCreator) => Promise<R>;

export type Converter<
  E extends BaseEventOrResult = InternalEvent,
  R extends BaseEventOrResult = InternalResult,
> = {
  convertFrom: (event: any) => Promise<E>;
  convertTo: (result: R) => any;
};

export type WrapperHandler<
  E extends BaseEventOrResult = InternalEvent,
  R extends BaseEventOrResult = InternalResult,
> = (
  handler: OpenNextHandler<E, R>,
  converter: Converter<E, R>,
) => Promise<(...args: any[]) => any>;

export type Wrapper<
  E extends BaseEventOrResult = InternalEvent,
  R extends BaseEventOrResult = InternalResult,
> = {
  wrapper: WrapperHandler<E, R>;
  name: string;
  supportStreaming: boolean;
};

type Warmer = (warmerId: string) => Promise<
  {
    statusCode: number;
    payload: {
      serverId: string;
    };
    type: "warmer";
  }[]
>;

type ImageLoader = (url: string) => Promise<{
  body?: Readable;
  contentType?: string;
  cacheControl?: string;
}>;

export type IncludedWrapper =
  | "aws-lambda"
  | "aws-lambda-streaming"
  | "node"
  | "cloudflare";

export type IncludedConverter =
  | "aws-apigw-v2"
  | "aws-apigw-v1"
  | "aws-cloudfront"
  | "edge"
  | "node"
  | "sqs-revalidate"
  | "dummy";

export type IncludedQueue = "sqs";

export type IncludedIncrementalCache = "s3";

export type IncludedTagCache = "dynamodb";

export interface DefaultOverrideOptions<
  E extends BaseEventOrResult = InternalEvent,
  R extends BaseEventOrResult = InternalResult,
> {
  /**
   * This is the main entrypoint of your app.
   * @default "aws-lambda"
   */
  wrapper?: IncludedWrapper | LazyLoadedOverride<Wrapper<E, R>>;

  /**
   * This code convert the event to InternalEvent and InternalResult to the expected output.
   * @default "aws-apigw-v2"
   */
  converter?: IncludedConverter | LazyLoadedOverride<Converter<E, R>>;
  /**
   * Generate a basic dockerfile to deploy the app.
   * If a string is provided, it will be used as the base dockerfile.
   * @default false
   */
  generateDockerfile?: boolean | string;
}

export interface OverrideOptions extends DefaultOverrideOptions {
  /**
   * Add possibility to override the default s3 cache. Used for fetch cache and html/rsc/json cache.
   * @default "s3"
   */
  incrementalCache?: "s3" | LazyLoadedOverride<IncrementalCache>;

  /**
   * Add possibility to override the default tag cache. Used for revalidateTags and revalidatePath.
   * @default "dynamodb"
   */
  tagCache?: "dynamodb" | LazyLoadedOverride<TagCache>;

  /**
   * Add possibility to override the default queue. Used for isr.
   * @default "sqs"
   */
  queue?: "sqs" | LazyLoadedOverride<Queue>;
}

export interface DefaultFunctionOptions<
  E extends BaseEventOrResult = InternalEvent,
  R extends BaseEventOrResult = InternalResult,
> {
  /**
   * Minify the server bundle.
   * @default false
   */
  minify?: boolean;
  /**
   * Print debug information.
   * @default false
   */
  debug?: boolean;
  /**
   * Enable overriding the default lambda.
   */
  override?: DefaultOverrideOptions<E, R>;
}

interface FunctionOptions extends DefaultFunctionOptions {
  /**
   * TODO: implement edge runtime
   * @default "node"
   */
  runtime?: "node" | "edge";
  /**
   * Here you should specify all the routes you want to use.
   * If not provided, all the routes will be used.
   * @default []
   */
  routes?: string[];
  /**
   * Enable overriding the default lambda.
   */
  override?: OverrideOptions;
}

export interface BuildOptions {
  functions: {
    default: Omit<FunctionOptions, "routes">;
    [key: string]: FunctionOptions;
  };

  /**
   * Override the default middleware
   * If you set this options, the middleware need to be deployed separately.
   * It supports both edge and node runtime.
   * TODO: actually implement it
   * @default undefined
   */
  middleware?: DefaultFunctionOptions & {
    //We force the middleware to be a function
    external: true;
  };

  /**
   * Override the default warmer
   * By default, works for lambda only.
   * If you override this, you'll need to handle the warmer event in the wrapper
   * @default undefined
   */
  warmer?: DefaultFunctionOptions<WarmerEvent, WarmerResponse> & {
    invokeFunction: "aws-lambda" | LazyLoadedOverride<Warmer>;
  };

  /**
   * Override the default revalidate function
   * By default, works for lambda and on SQS event.
   * Supports only node runtime
   */
  revalidate?: DefaultFunctionOptions<
    { host: string; url: string; type: "revalidate" },
    { type: "revalidate" }
  >;

  /**
   * Override the default revalidate function
   * By default, works on lambda and for S3 key.
   * Supports only node runtime
   */
  imageOptimization?: DefaultFunctionOptions & {
    loader?: "s3" | LazyLoadedOverride<ImageLoader>;
  };

  /**
   * Override the default initialization function
   * By default, works for lambda and on SQS event.
   * Supports only node runtime
   */
  initializationFunction?: DefaultFunctionOptions & {
    tagCache?: "dynamodb" | LazyLoadedOverride<TagCache>;
  };

  /**
   * The command to build the Next.js app.
   * @default `npm run build`, `yarn build`, or `pnpm build` based on the lock file found in the app's directory or any of its parent directories.
   * @example
   * ```ts
   * build({
   *   buildCommand: "pnpm custom:build",
   * });
   * ```
   */
  /**
   * Dangerous options. This break some functionnality but can be useful in some cases.
   */
  dangerous?: DangerousOptions;
  buildCommand?: string;
  /**
   * The path to the target folder of build output from the `buildCommand` option (the path which will contain the `.next` and `.open-next` folders). This path is relative from the current process.cwd().
   * @default "."
   */
  buildOutputPath?: string;
  /**
   * The path to the root of the Next.js app's source code. This path is relative from the current process.cwd().
   * @default "."
   */
  appPath?: string;
  /**
   * The path to the package.json file of the Next.js app. This path is relative from the current process.cwd().
   * @default "."
   */
  packageJsonPath?: string;
}
