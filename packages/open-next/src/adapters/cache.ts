import { IncrementalCache } from "../cache/incremental/types.js";
import { TagCache } from "../cache/tag/types.js";
import { debug, error, warn } from "./logger.js";

interface CachedFetchValue {
  kind: "FETCH";
  data: {
    headers: { [k: string]: string };
    body: string;
    url: string;
    status?: number;
    tags?: string[];
  };
  revalidate: number;
}

interface CachedRedirectValue {
  kind: "REDIRECT";
  props: Object;
}

interface CachedRouteValue {
  kind: "ROUTE";
  // this needs to be a RenderResult so since renderResponse
  // expects that type instead of a string
  body: Buffer;
  status: number;
  headers: Record<string, undefined | string | string[]>;
}

interface CachedImageValue {
  kind: "IMAGE";
  etag: string;
  buffer: Buffer;
  extension: string;
  isMiss?: boolean;
  isStale?: boolean;
}

interface IncrementalCachedPageValue {
  kind: "PAGE";
  // this needs to be a string since the cache expects to store
  // the string value
  html: string;
  pageData: Object;
  status?: number;
  headers?: Record<string, undefined | string>;
}

type IncrementalCacheValue =
  | CachedRedirectValue
  | IncrementalCachedPageValue
  | CachedImageValue
  | CachedFetchValue
  | CachedRouteValue;

type IncrementalCacheContext = {
  revalidate?: number | false | undefined;
  fetchCache?: boolean | undefined;
  fetchUrl?: string | undefined;
  fetchIdx?: number | undefined;
  tags?: string[] | undefined;
};

interface CacheHandlerContext {
  fs?: never;
  dev?: boolean;
  flushToDisk?: boolean;
  serverDistDir?: string;
  maxMemoryCacheSize?: number;
  _appDir: boolean;
  _requestHeaders: never;
  fetchCacheKeyPrefix?: string;
}

interface CacheHandlerValue {
  lastModified?: number;
  age?: number;
  cacheState?: string;
  value: IncrementalCacheValue | null;
}

/** Beginning single backslash is intentional, to look for the dot + the extension. Do not escape it again. */
const CACHE_EXTENSION_REGEX = /\.(cache|fetch)$/;

export function hasCacheExtension(key: string) {
  return CACHE_EXTENSION_REGEX.test(key);
}

declare global {
  var incrementalCache: IncrementalCache;
  var tagCache: TagCache;
  var disableDynamoDBCache: boolean;
  var disableIncrementalCache: boolean;
  var lastModified: number;
}

export default class S3Cache {
  private client: IncrementalCache;
  private tagClient: TagCache;

  constructor(_ctx: CacheHandlerContext) {
    this.client = globalThis.incrementalCache;
    this.tagClient = globalThis.tagCache;
  }

  public async get(
    key: string,
    // fetchCache is for next 13.5 and above, kindHint is for next 14 and above and boolean is for earlier versions
    options?:
      | boolean
      | { fetchCache?: boolean; kindHint?: "app" | "pages" | "fetch" },
  ) {
    if (globalThis.disableIncrementalCache) {
      return null;
    }
    const isFetchCache =
      typeof options === "object"
        ? options.kindHint
          ? options.kindHint === "fetch"
          : options.fetchCache
        : options;
    return isFetchCache
      ? this.getFetchCache(key)
      : this.getIncrementalCache(key);
  }

  async getFetchCache(key: string) {
    debug("get fetch cache", { key });
    try {
      const { value, lastModified } = await this.client.get(key, true);
      // const { Body, LastModified } = await this.getS3Object(key, "fetch");
      const _lastModified = await this.tagClient.getLastModified(
        key,
        lastModified,
      );
      if (_lastModified === -1) {
        // If some tags are stale we need to force revalidation
        return null;
      }

      if (value === undefined) return null;

      return {
        lastModified: _lastModified,
        value: value,
      } as CacheHandlerValue;
    } catch (e) {
      error("Failed to get fetch cache", e);
      return null;
    }
  }

  async getIncrementalCache(key: string): Promise<CacheHandlerValue | null> {
    try {
      const { value: cacheData, lastModified } = await this.client.get(
        key,
        false,
      );
      // const { Body, LastModified } = await this.getS3Object(key, "cache");
      // const cacheData = JSON.parse(
      //   (await Body?.transformToString()) ?? "{}",
      // ) as S3CachedFile;
      const meta = cacheData?.meta;
      const _lastModified = await this.tagClient.getLastModified(
        key,
        lastModified,
      );
      if (_lastModified === -1) {
        // If some tags are stale we need to force revalidation
        return null;
      }
      globalThis.lastModified = _lastModified;
      if (cacheData?.type === "route") {
        return {
          lastModified: _lastModified,
          value: {
            kind: "ROUTE",
            body: Buffer.from(cacheData.body ?? Buffer.alloc(0)),
            status: meta?.status,
            headers: meta?.headers,
          },
        } as CacheHandlerValue;
      } else if (cacheData?.type === "page" || cacheData?.type === "app") {
        return {
          lastModified: _lastModified,
          value: {
            kind: "PAGE",
            html: cacheData.html,
            pageData:
              cacheData.type === "page" ? cacheData.json : cacheData.rsc,
            status: meta?.status,
            headers: meta?.headers,
          },
        } as CacheHandlerValue;
      } else if (cacheData?.type === "redirect") {
        return {
          lastModified: _lastModified,
          value: {
            kind: "REDIRECT",
            props: cacheData.props,
          },
        } as CacheHandlerValue;
      } else {
        warn("Unknown cache type", cacheData);
        return null;
      }
    } catch (e) {
      error("Failed to get body cache", e);
      return null;
    }
  }

  async set(
    key: string,
    data?: IncrementalCacheValue,
    ctx?: IncrementalCacheContext,
  ): Promise<void> {
    if (globalThis.disableIncrementalCache) {
      return;
    }
    if (data?.kind === "ROUTE") {
      const { body, status, headers } = data;
      await this.client.set(
        key,
        {
          type: "route",
          body: body.toString("utf8"),
          meta: {
            status,
            headers,
          },
        },
        false,
      );
    } else if (data?.kind === "PAGE") {
      const { html, pageData } = data;
      const isAppPath = typeof pageData === "string";
      if (isAppPath) {
        this.client.set(
          key,
          {
            type: "app",
            html,
            rsc: pageData,
          },
          false,
        );
      } else {
        this.client.set(
          key,
          {
            type: "page",
            html,
            json: pageData,
          },
          false,
        );
      }
    } else if (data?.kind === "FETCH") {
      await this.client.set<true>(key, data, true);
    } else if (data?.kind === "REDIRECT") {
      await this.client.set(
        key,
        {
          type: "redirect",
          props: data.props,
        },
        false,
      );
    } else if (data === null || data === undefined) {
      await this.client.delete(key);
    }
    // Write derivedTags to dynamodb
    // If we use an in house version of getDerivedTags in build we should use it here instead of next's one
    const derivedTags: string[] =
      data?.kind === "FETCH"
        ? ctx?.tags ?? data?.data?.tags ?? [] // before version 14 next.js used data?.data?.tags so we keep it for backward compatibility
        : data?.kind === "PAGE"
        ? data.headers?.["x-next-cache-tags"]?.split(",") ?? []
        : [];
    debug("derivedTags", derivedTags);
    // Get all tags stored in dynamodb for the given key
    // If any of the derived tags are not stored in dynamodb for the given key, write them
    const storedTags = await this.tagClient.getByPath(key);
    const tagsToWrite = derivedTags.filter((tag) => !storedTags.includes(tag));
    if (tagsToWrite.length > 0) {
      await this.tagClient.writeTags(
        tagsToWrite.map((tag) => ({
          path: key,
          tag: tag,
        })),
      );
    }
  }

  public async revalidateTag(tag: string) {
    if (globalThis.disableDynamoDBCache || globalThis.disableIncrementalCache) {
      return;
    }
    debug("revalidateTag", tag);
    // Find all keys with the given tag
    const paths = await this.tagClient.getByTag(tag);
    debug("Items", paths);
    // Update all keys with the given tag with revalidatedAt set to now
    await this.tagClient.writeTags(
      paths?.map((path) => ({
        path: path,
        tag: tag,
      })) ?? [],
    );
  }
}
