import type {
  CacheHandlerValue,
  IncrementalCacheContext,
  IncrementalCacheValue,
} from "types/cache";
import {
  getStaleLastModified,
  getTagsFromValue,
  hasBeenRevalidated,
  isStale,
  writeTags,
} from "utils/cache";
import { isBinaryContentType } from "../utils/binary";
import { CACHE_TAGS_HEADER } from "../utils/cacheHeaders";
import { compareSemver } from "../utils/semver";
import { debug, error, warn } from "./logger";

export const SOFT_TAG_PREFIX = "_N_T_/";

function isFetchCache(
  options?:
    | boolean
    | {
        fetchCache?: boolean;
        kindHint?: "app" | "pages" | "fetch";
        kind?: "FETCH";
      },
): boolean {
  if (typeof options === "boolean") {
    return options;
  }
  if (typeof options === "object") {
    return (
      options.kindHint === "fetch" ||
      options.fetchCache ||
      options.kind === "FETCH"
    );
  }
  return false;
}
// We need to use globalThis client here as this class can be defined at load time in next 12 but client is not available at load time
export default class Cache {
  public async get(
    key: string,
    // fetchCache is for next 13.5 and above, kindHint is for next 14 and above and boolean is for earlier versions
    options?:
      | boolean
      | {
          fetchCache?: boolean;
          kindHint?: "app" | "pages" | "fetch";
          tags?: string[];
          softTags?: string[];
          kind?: "FETCH";
        },
  ) {
    if (globalThis.openNextConfig.dangerous?.disableIncrementalCache) {
      return null;
    }

    const softTags = typeof options === "object" ? options.softTags : [];
    const tags = typeof options === "object" ? options.tags : [];
    return isFetchCache(options)
      ? this.getFetchCache(key, softTags, tags)
      : this.getIncrementalCache(key);
  }

  async getFetchCache(key: string, softTags?: string[], tags?: string[]) {
    debug("get fetch cache", { key, softTags, tags });
    try {
      const cachedEntry = await globalThis.incrementalCache.get(key, "fetch");

      if (cachedEntry?.value === undefined) return null;

      const _tags = [...(tags ?? []), ...(softTags ?? [])];
      const _lastModified = cachedEntry.lastModified ?? Date.now();
      const _hasBeenRevalidated = cachedEntry.shouldBypassTagCache
        ? false
        : await hasBeenRevalidated(key, _tags, cachedEntry);

      if (_hasBeenRevalidated) return null;

      // For cases where we don't have tags, we need to ensure that the soft tags are not being revalidated
      // We only need to check for the path as it should already contain all the tags
      if ((tags ?? []).length === 0) {
        // Then we need to find the path for the given key
        const path = softTags?.find(
          (tag) =>
            tag.startsWith(SOFT_TAG_PREFIX) &&
            !tag.endsWith("layout") &&
            !tag.endsWith("page"),
        );
        if (path) {
          const hasPathBeenUpdated = cachedEntry.shouldBypassTagCache
            ? false
            : await hasBeenRevalidated(
                path.replace(SOFT_TAG_PREFIX, ""),
                [],
                cachedEntry,
              );
          if (hasPathBeenUpdated) {
            // In case the path has been revalidated, we don't want to use the fetch cache
            return null;
          }
        }
      }

      const _isStale = cachedEntry.shouldBypassTagCache
        ? false
        : await isStale(key, _tags, _lastModified);

      return {
        lastModified: _isStale ? 1 : _lastModified,
        value: cachedEntry.value,
      } as CacheHandlerValue;
    } catch (e) {
      // We can usually ignore errors here as they are usually due to cache not being found
      debug("Failed to get fetch cache", e);
      return null;
    }
  }

  async getIncrementalCache(key: string): Promise<CacheHandlerValue | null> {
    try {
      const cachedEntry = await globalThis.incrementalCache.get(key, "cache");

      if (!cachedEntry?.value) {
        return null;
      }

      const cacheData = cachedEntry.value;

      const meta = cacheData.meta;
      const tags = getTagsFromValue(cacheData);
      let _lastModified = cachedEntry.lastModified ?? Date.now();
      const _hasBeenRevalidated = cachedEntry.shouldBypassTagCache
        ? false
        : await hasBeenRevalidated(key, tags, cachedEntry);
      if (_hasBeenRevalidated) return null;

      const _isStale = cachedEntry.shouldBypassTagCache
        ? false
        : await isStale(key, tags, _lastModified);

      const store = globalThis.__openNextAls.getStore();
      if (store) {
        // The sentinel is kept as is in the store so that the revalidation queue keeps
        // deduplicating every stale request for the same path.
        store.lastModified = _isStale ? 1 : _lastModified;
      }
      if (_isStale) {
        _lastModified = getStaleLastModified(cacheData.revalidate);
      }

      if (cacheData?.type === "route") {
        return {
          lastModified: _lastModified,
          value: {
            kind: compareSemver(globalThis.nextVersion, ">=", "15.0.0")
              ? "APP_ROUTE"
              : "ROUTE",
            body: Buffer.from(
              cacheData.body ?? Buffer.alloc(0),
              isBinaryContentType(String(meta?.headers?.["content-type"]))
                ? "base64"
                : "utf8",
            ),
            status: meta?.status,
            headers: meta?.headers,
          },
        } as CacheHandlerValue;
      }
      if (cacheData?.type === "page" || cacheData?.type === "app") {
        // Without the html there is no valid value to return, so we report a miss and let
        // the server render the page. Next.js behaves the same way, its file system cache
        // reads the `.html` file first and turns a read failure into a miss.
        //
        // The check is on `undefined` and not on falsiness because an empty string is a
        // valid value: a PPR route with an empty static shell has an empty `.html` file.
        if (cacheData.html === undefined) {
          warn("No html in the cache entry", key);
          return null;
        }
        if (
          compareSemver(globalThis.nextVersion, ">=", "15.0.0") &&
          cacheData?.type === "app"
        ) {
          const segmentData = new Map<string, Buffer>();
          if (cacheData.segmentData) {
            for (const [segmentPath, segmentContent] of Object.entries(
              cacheData.segmentData ?? {},
            )) {
              segmentData.set(segmentPath, Buffer.from(segmentContent));
            }
          }
          return {
            lastModified: _lastModified,
            value: {
              kind: "APP_PAGE",
              html: cacheData.html,
              // `rsc` is absent when the build collected neither a `.rsc` nor a
              // `.prefetch.rsc` file, see `CachedFile`. An undefined value is expected: the
              // Next.js file system cache also leaves `rscData` undefined for fallback
              // shells, and on 16.2+ for postponed PPR routes.
              rscData:
                cacheData.rsc === undefined
                  ? undefined
                  : Buffer.from(cacheData.rsc),
              status: meta?.status,
              headers: meta?.headers,
              postponed: meta?.postponed,
              segmentData,
            },
          } as CacheHandlerValue;
        }
        const pageData =
          cacheData.type === "page" ? cacheData.json : cacheData.rsc;
        // Only reachable for an app page on Next.js < 15, where an absent `rsc` leaves us
        // without any page data to return.
        if (pageData === undefined) {
          warn("No page data in the cache entry", key);
          return null;
        }
        return {
          lastModified: _lastModified,
          value: {
            kind: compareSemver(globalThis.nextVersion, ">=", "15.0.0")
              ? "PAGES"
              : "PAGE",
            html: cacheData.html,
            pageData,
            status: meta?.status,
            headers: meta?.headers,
          },
        } as CacheHandlerValue;
      }
      if (cacheData?.type === "redirect") {
        return {
          lastModified: _lastModified,
          value: {
            kind: "REDIRECT",
            props: cacheData.props,
          },
        } as CacheHandlerValue;
      }
      warn("Unknown cache type", cacheData);
      return null;
    } catch (e) {
      // We can usually ignore errors here as they are usually due to cache not being found
      debug("Failed to get body cache", e);
      return null;
    }
  }

  async set(
    key: string,
    data?: IncrementalCacheValue,
    ctx?: IncrementalCacheContext,
  ): Promise<void> {
    if (globalThis.openNextConfig.dangerous?.disableIncrementalCache) {
      return;
    }
    const store = globalThis.__openNextAls.getStore();
    // This one might not even be necessary anymore
    // Better be safe than sorry
    const detachedPromise = store?.pendingPromiseRunner.withResolvers<void>();

    const writePromise = this.writeCache(key, data, ctx).finally(() => {
      // We need to resolve the promise even if there was an error
      detachedPromise?.resolve();
    });

    // Next.js ignores the value returned by `set`, so the write goes to `waitUntil` when the
    // wrapper provides one. It is handed over directly because the pending promise runner is
    // already drained when detached writes call `set`. Everything else is awaited, as are
    // `FETCH` entries: Next.js releases the fetch cache lock when the write settles.
    if (store?.waitUntil && data?.kind !== "FETCH") {
      store.waitUntil(writePromise);
      return;
    }
    await writePromise;
  }

  private async writeCache(
    key: string,
    data?: IncrementalCacheValue,
    ctx?: IncrementalCacheContext,
  ): Promise<void> {
    try {
      if (data === null || data === undefined) {
        await globalThis.incrementalCache.delete(key);
      } else {
        const revalidate = this.extractRevalidateForSet(ctx);
        switch (data.kind) {
          case "ROUTE":
          case "APP_ROUTE": {
            const { body, status, headers } = data;
            await globalThis.incrementalCache.set(
              key,
              {
                type: "route",
                body: body.toString(
                  isBinaryContentType(String(headers["content-type"]))
                    ? "base64"
                    : "utf8",
                ),
                meta: {
                  status,
                  headers,
                },
                revalidate,
              },
              "cache",
            );
            break;
          }
          case "PAGE":
          case "PAGES": {
            const { html, pageData, status, headers } = data;
            const isAppPath = typeof pageData === "string";
            if (isAppPath) {
              await globalThis.incrementalCache.set(
                key,
                {
                  type: "app",
                  html,
                  rsc: pageData,
                  meta: {
                    status,
                    headers,
                  },
                  revalidate,
                },
                "cache",
              );
            } else {
              await globalThis.incrementalCache.set(
                key,
                {
                  type: "page",
                  html,
                  json: pageData,
                  revalidate,
                },
                "cache",
              );
            }
            break;
          }
          case "APP_PAGE": {
            const { html, rscData, headers, status, segmentData, postponed } =
              data;
            const segmentToWrite: Record<string, string> = {};
            if (segmentData) {
              for (const [
                segmentPath,
                segmentContent,
              ] of segmentData.entries()) {
                segmentToWrite[segmentPath] = segmentContent.toString("utf8");
              }
            }
            await globalThis.incrementalCache.set(
              key,
              {
                type: "app",
                html,
                rsc: rscData?.toString("utf8"),
                meta: {
                  status,
                  headers,
                  postponed,
                },
                revalidate,
                segmentData: segmentData ? segmentToWrite : undefined,
              },
              "cache",
            );
            break;
          }
          case "FETCH":
            await globalThis.incrementalCache.set(key, data, "fetch");
            break;
          case "REDIRECT":
            await globalThis.incrementalCache.set(
              key,
              {
                type: "redirect",
                props: data.props,
                revalidate,
              },
              "cache",
            );
            break;
          case "IMAGE":
            // Not implemented
            break;
        }
      }

      await this.updateTagsOnSet(key, data, ctx);
      debug("Finished setting cache");
    } catch (e) {
      error("Failed to set cache", e);
    }
  }

  public async revalidateTag(
    tags: string | string[],
    durations?: { expire?: number },
  ) {
    const config = globalThis.openNextConfig.dangerous;
    if (config?.disableTagCache || config?.disableIncrementalCache) {
      return;
    }
    const _tags = Array.isArray(tags) ? tags : [tags];
    if (_tags.length === 0) {
      return;
    }

    try {
      if (globalThis.tagCache.mode === "nextMode") {
        const paths = (await globalThis.tagCache.getPathsByTags?.(_tags)) ?? [];

        const now = Date.now();
        const tagsToWrite = _tags.map((tag) => {
          if (durations) {
            // Use provided durations
            return {
              tag,
              stale: now,
              expire:
                durations.expire !== undefined
                  ? now + durations.expire * 1000
                  : undefined,
            };
          }
          // Immediate expiration, default behavior before next 16, now only with {expire: 0}
          return {
            tag,
            expire: now,
          };
        });

        await writeTags(tagsToWrite);
        if (paths.length > 0) {
          // TODO: we should introduce a new method in cdnInvalidationHandler to invalidate paths by tags for cdn that supports it
          // It also means that we'll need to provide the tags used in every request to the wrapper or converter.
          await globalThis.cdnInvalidationHandler.invalidatePaths(
            paths.map((path) => ({
              initialPath: path,
              rawPath: path,
              resolvedRoutes: [
                {
                  route: path,
                  // TODO: ideally here we should check if it's an app router page or route
                  type: "app",
                },
              ],
            })),
          );
        }
        return;
      }

      for (const tag of _tags) {
        debug("revalidateTag", tag);
        // Find all keys with the given tag
        const paths = await globalThis.tagCache.getByTag(tag);
        debug("Items", paths);
        const now = Date.now();
        const toInsert = paths.map((path) => {
          const baseEntry = { path, tag };
          if (durations) {
            // Use provided durations
            return {
              ...baseEntry,
              stale: now,
              expire:
                durations.expire !== undefined
                  ? now + durations.expire * 1000
                  : undefined,
            };
          }
          // Default behavior: immediate expiration
          return {
            ...baseEntry,
            expire: now,
          };
        });

        // If the tag is a soft tag, we should also revalidate the hard tags
        if (tag.startsWith(SOFT_TAG_PREFIX)) {
          for (const path of paths) {
            // We need to find all hard tags for a given path
            const _tags = await globalThis.tagCache.getByPath(path);
            const hardTags = _tags.filter(
              (t) => !t.startsWith(SOFT_TAG_PREFIX),
            );
            // For every hard tag, we need to find all paths and revalidate them
            for (const hardTag of hardTags) {
              const _paths = await globalThis.tagCache.getByTag(hardTag);
              debug({ hardTag, _paths });
              toInsert.push(
                ..._paths.map((path) => {
                  const baseEntry = { path, tag: hardTag };
                  if (durations) {
                    return {
                      ...baseEntry,
                      stale: now,
                      expire:
                        durations.expire !== undefined
                          ? now + durations.expire * 1000
                          : undefined,
                    };
                  }
                  return {
                    ...baseEntry,
                    expire: now,
                  };
                }),
              );
            }
          }
        }

        // Update all keys with the given tag with revalidatedAt set to now
        await writeTags(toInsert);

        // We can now invalidate all paths in the CDN
        // This only applies to `revalidateTag`, not to `res.revalidate()`
        const uniquePaths = Array.from(
          new Set(
            toInsert
              // We need to filter fetch cache key as they are not in the CDN
              .filter((t) => t.tag.startsWith(SOFT_TAG_PREFIX))
              .map((t) => `/${t.path}`),
          ),
        );
        if (uniquePaths.length > 0) {
          await globalThis.cdnInvalidationHandler.invalidatePaths(
            uniquePaths.map((path) => ({
              initialPath: path,
              rawPath: path,
              resolvedRoutes: [
                {
                  route: path,
                  // TODO: ideally here we should check if it's an app router page or route
                  type: "app",
                },
              ],
            })),
          );
        }
      }
    } catch (e) {
      error("Failed to revalidate tag", e);
    }
  }

  // TODO: We should delete/update tags in this method
  // This will require an update to the tag cache interface
  private async updateTagsOnSet(
    key: string,
    data?: IncrementalCacheValue,
    ctx?: IncrementalCacheContext,
  ) {
    if (
      globalThis.openNextConfig.dangerous?.disableTagCache ||
      globalThis.tagCache.mode === "nextMode" ||
      // Here it means it's a delete
      !data
    ) {
      return;
    }
    // Write derivedTags to the tag cache
    // If we use an in house version of getDerivedTags in build we should use it here instead of next's one
    // `x-next-cache-tags` is always a comma separated string: Next.js sets it from
    // `metadata.fetchTags`, which is a string. The header type allows an array because it
    // is shared with headers that can legitimately repeat, so we narrow on `typeof` here.
    // Next.js guards the same way when it reads the header back.
    const pageCacheTags =
      data?.kind === "PAGE" || data?.kind === "APP_PAGE"
        ? data.headers?.[CACHE_TAGS_HEADER]
        : undefined;
    const derivedTags: string[] =
      data?.kind === "FETCH"
        ? //@ts-expect-error - On older versions of next, ctx was a number, but for these cases we use data?.data?.tags
          (ctx?.tags ?? data?.data?.tags ?? []) // before version 14 next.js used data?.data?.tags so we keep it for backward compatibility
        : typeof pageCacheTags === "string"
          ? pageCacheTags.split(",")
          : [];
    debug("derivedTags", derivedTags);

    // Get all tags stored in dynamodb for the given key
    // If any of the derived tags are not stored in dynamodb for the given key, write them
    const storedTags = await globalThis.tagCache.getByPath(key);
    const tagsToWrite = derivedTags.filter((tag) => !storedTags.includes(tag));
    if (tagsToWrite.length > 0) {
      await writeTags(
        tagsToWrite.map((tag) => ({
          path: key,
          tag: tag,
          // In case the tags are not there we just need to create them
          // but we don't want them to return from `getLastModified` as they are not stale
          revalidatedAt: 1,
        })),
      );
    }
  }

  private extractRevalidateForSet(
    ctx?: IncrementalCacheContext,
  ): number | false | undefined {
    if (ctx === undefined) {
      return undefined;
    }
    if (typeof ctx === "number" || ctx === false) {
      return ctx;
    }
    if ("revalidate" in ctx) {
      return ctx.revalidate;
    }
    if ("cacheControl" in ctx) {
      return ctx.cacheControl?.revalidate;
    }
    return undefined;
  }
}
