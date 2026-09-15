/* eslint-disable sonarjs/no-duplicate-string */
import Cache, { SOFT_TAG_PREFIX } from "@opennextjs/aws/adapters/cache.js";
import { RequestCache } from "@opennextjs/aws/utils/requestCache.js";
import { type Mock, vi } from "vitest";

declare global {
  var openNextConfig: {
    dangerous: { disableIncrementalCache?: boolean; disableTagCache?: boolean };
  };
  var nextVersion: string;
}

describe("CacheHandler", () => {
  let cache: Cache;

  vi.useFakeTimers().setSystemTime("2024-01-02T00:00:00Z");
  const getFetchCacheSpy = vi.spyOn(Cache.prototype, "getFetchCache");
  const getIncrementalCache = vi.spyOn(Cache.prototype, "getIncrementalCache");

  const incrementalCache = {
    name: "mock",
    get: vi.fn().mockResolvedValue({
      value: {
        type: "route",
        body: "{}",
      },
      lastModified: Date.now(),
    }),
    set: vi.fn(),
    delete: vi.fn(),
  };
  globalThis.incrementalCache = incrementalCache;

  const tagCache = {
    name: "mock",
    mode: "original",
    hasBeenRevalidated: vi.fn(),
    getByTag: vi.fn(),
    getByPath: vi.fn(),
    getLastModified: vi
      .fn()
      .mockResolvedValue(new Date("2024-01-02T00:00:00Z").getTime()),
    writeTags: vi.fn(),
    isStale: vi.fn().mockResolvedValue(false),
    getPathsByTags: undefined as Mock | undefined,
  };
  globalThis.tagCache = tagCache;

  const invalidateCdnHandler = {
    name: "mock",
    invalidatePaths: vi.fn(),
  };
  globalThis.cdnInvalidationHandler = invalidateCdnHandler;

  globalThis.__openNextAls = {
    getStore: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset the getStore mock to return a fresh Set for each test
    (globalThis.__openNextAls.getStore as Mock).mockReturnValue({
      pendingPromiseRunner: {
        withResolvers: vi.fn().mockReturnValue({
          resolve: vi.fn(),
        }),
      },
      writtenTags: new Set(),
    });

    cache = new Cache();

    globalThis.openNextConfig = {
      dangerous: {
        disableIncrementalCache: false,
      },
    };
    globalThis.nextVersion = "14.0.0";
    tagCache.mode = "original";
    tagCache.getPathsByTags = undefined;
  });

  describe("get", () => {
    it("Should return null for cache miss", async () => {
      incrementalCache.get.mockResolvedValueOnce({});

      const result = await cache.get("key");

      expect(result).toBeNull();
    });

    describe("disableIncrementalCache", () => {
      beforeEach(() => {
        globalThis.openNextConfig.dangerous.disableIncrementalCache = true;
      });

      it("Should return null when incremental cache is disabled", async () => {
        const result = await cache.get("key");

        expect(result).toBeNull();
      });

      it("Should not set cache when incremental cache is disabled", async () => {
        globalThis.openNextConfig.dangerous.disableIncrementalCache = true;

        await cache.set("key", { kind: "REDIRECT", props: {} });

        expect(incrementalCache.set).not.toHaveBeenCalled();
      });

      it("Should not delete cache when incremental cache is disabled", async () => {
        globalThis.openNextConfig.dangerous.disableIncrementalCache = true;

        await cache.set("key", undefined);

        expect(incrementalCache.delete).not.toHaveBeenCalled();
      });
    });

    describe("fetch cache", () => {
      it("Should retrieve cache from fetch cache when fetch cache is true (next 13.5+)", async () => {
        await cache.get("key", { fetchCache: true });

        expect(getFetchCacheSpy).toHaveBeenCalled();
      });

      it("Should retrieve cache from fetch cache when hint is fetch (next14)", async () => {
        await cache.get("key", { kindHint: "fetch" });

        expect(getFetchCacheSpy).toHaveBeenCalled();
      });

      describe("next15", () => {
        beforeEach(() => {
          globalThis.nextVersion = "15.0.0";
        });

        it("Should retrieve cache from fetch cache when hint is fetch", async () => {
          await cache.get("key", { kind: "FETCH" });

          expect(getFetchCacheSpy).toHaveBeenCalled();
        });

        it("Should return null when tag cache last modified is -1", async () => {
          tagCache.getLastModified.mockResolvedValueOnce(-1);

          const result = await cache.get("key", { kind: "FETCH" });

          expect(getFetchCacheSpy).toHaveBeenCalled();
          expect(result).toBeNull();
        });

        it("Should return null with nextMode tag cache that has been revalidated", async () => {
          tagCache.mode = "nextMode";
          tagCache.hasBeenRevalidated.mockResolvedValueOnce(true);

          const result = await cache.get("key", {
            kind: "FETCH",
            tags: ["tag"],
          });
          expect(getFetchCacheSpy).toHaveBeenCalled();
          expect(tagCache.hasBeenRevalidated).toHaveBeenCalled();
          expect(result).toBeNull();
        });

        it("Should return null when incremental cache throws", async () => {
          incrementalCache.get.mockRejectedValueOnce(
            new Error("Error retrieving cache"),
          );

          const result = await cache.get("key", { kind: "FETCH" });

          expect(getFetchCacheSpy).toHaveBeenCalled();
          expect(result).toBeNull();
        });
      });

      describe("stale tags", () => {
        beforeEach(() => {
          globalThis.nextVersion = "16.0.0";
        });

        it("Should return lastModified as 1 when tag is stale", async () => {
          tagCache.mode = "nextMode";
          tagCache.hasBeenRevalidated.mockResolvedValueOnce(false);
          tagCache.isStale.mockResolvedValueOnce(true);
          const cachedLastModified = Date.now();
          incrementalCache.get.mockResolvedValueOnce({
            value: {
              kind: "FETCH",
              data: {
                headers: {},
                body: "{}",
                url: "https://example.com",
                status: 200,
              },
            },
            lastModified: cachedLastModified,
          });

          const result = await cache.get("key", {
            kind: "FETCH",
            tags: ["tag1"],
          });

          expect(result).not.toBeNull();
          expect(result?.lastModified).toEqual(1);
        });

        it("Should return original lastModified when tag is not stale", async () => {
          tagCache.mode = "nextMode";
          tagCache.hasBeenRevalidated.mockResolvedValueOnce(false);
          tagCache.isStale.mockResolvedValueOnce(false);
          const cachedLastModified = Date.now();
          incrementalCache.get.mockResolvedValueOnce({
            value: {
              kind: "FETCH",
              data: {
                headers: {},
                body: "{}",
                url: "https://example.com",
                status: 200,
              },
            },
            lastModified: cachedLastModified,
          });

          const result = await cache.get("key", {
            kind: "FETCH",
            tags: ["tag1"],
          });

          expect(result).not.toBeNull();
          expect(result?.lastModified).toEqual(cachedLastModified);
        });

        it("Should not call isStale when shouldBypassTagCache is true", async () => {
          incrementalCache.get.mockResolvedValueOnce({
            value: {
              kind: "FETCH",
              data: {
                headers: {},
                body: "{}",
                url: "https://example.com",
                status: 200,
              },
            },
            lastModified: Date.now(),
            shouldBypassTagCache: true,
          });

          await cache.get("key", { kind: "FETCH", tags: ["tag1"] });

          expect(tagCache.isStale).not.toHaveBeenCalled();
        });
      });
    });

    describe("incremental cache", () => {
      it.each(["app", "pages", undefined])(
        "Should retrieve cache from incremental cache when hint is not fetch: %s",
        async (kindHint) => {
          await cache.get("key", { kindHint: kindHint as any });

          expect(getIncrementalCache).toHaveBeenCalled();
        },
      );

      it("Should return null when tag cache last modified is -1", async () => {
        incrementalCache.get.mockResolvedValueOnce({
          value: {
            type: "route",
          },
          lastModified: Date.now(),
        });
        tagCache.getLastModified.mockResolvedValueOnce(-1);

        const result = await cache.get("key", { kindHint: "app" });

        expect(getIncrementalCache).toHaveBeenCalled();
        expect(result).toBeNull();
      });

      it("Should return null with nextMode tag cache that has been revalidated", async () => {
        tagCache.mode = "nextMode";
        tagCache.hasBeenRevalidated.mockResolvedValueOnce(true);
        incrementalCache.get.mockResolvedValueOnce({
          value: {
            type: "route",
            meta: {
              headers: {
                "x-next-cache-tags": "tag",
              },
            },
          },
          lastModified: Date.now(),
        });

        const result = await cache.get("key", { kindHint: "app" });

        expect(getIncrementalCache).toHaveBeenCalled();
        expect(tagCache.hasBeenRevalidated).toHaveBeenCalled();
        expect(result).toBeNull();
      });

      it("Should return value when cache data type is route", async () => {
        incrementalCache.get.mockResolvedValueOnce({
          value: {
            type: "route",
            body: "{}",
          },
          lastModified: Date.now(),
        });

        const result = await cache.get("key", { kindHint: "app" });

        expect(getIncrementalCache).toHaveBeenCalled();
        expect(result).toEqual({
          value: {
            kind: "ROUTE",
            body: Buffer.from("{}"),
          },
          lastModified: Date.now(),
        });
      });

      it("Should return base64 encoded value when cache data type is route and content is binary", async () => {
        incrementalCache.get.mockResolvedValueOnce({
          value: {
            type: "route",
            body: Buffer.from("hello").toString("base64"),
            meta: {
              headers: {
                "content-type": "image/png",
              },
            },
          },
          lastModified: Date.now(),
        });

        const result = await cache.get("key", { kindHint: "app" });

        expect(getIncrementalCache).toHaveBeenCalled();
        expect(result).toEqual({
          value: {
            kind: "ROUTE",
            body: Buffer.from("hello"),
            headers: {
              "content-type": "image/png",
            },
          },
          lastModified: Date.now(),
        });
      });

      it("Should return value when cache data type is app", async () => {
        incrementalCache.get.mockResolvedValueOnce({
          value: {
            type: "app",
            html: "<html></html>",
            rsc: "rsc",
            meta: {
              status: 200,
            },
          },
          lastModified: Date.now(),
        });

        const result = await cache.get("key", { kindHint: "app" });

        expect(getIncrementalCache).toHaveBeenCalled();
        expect(result).toEqual({
          value: {
            kind: "PAGE",
            html: "<html></html>",
            pageData: "rsc",
            status: 200,
          },
          lastModified: Date.now(),
        });
      });

      it("Should return value when cache data type is page", async () => {
        incrementalCache.get.mockResolvedValueOnce({
          value: {
            type: "page",
            html: "<html></html>",
            json: {},
            meta: {
              status: 200,
            },
          },
          lastModified: Date.now(),
        });

        const result = await cache.get("key", { kindHint: "pages" });

        expect(getIncrementalCache).toHaveBeenCalled();
        expect(result).toEqual({
          value: {
            kind: "PAGE",
            html: "<html></html>",
            pageData: {},
            status: 200,
          },
          lastModified: Date.now(),
        });
      });

      it("Should return value when cache data type is app with segmentData and postponed (Next 15+)", async () => {
        globalThis.nextVersion = "15.0.0";
        incrementalCache.get.mockResolvedValueOnce({
          value: {
            type: "app",
            html: "<html></html>",
            rsc: "rsc-data",
            segmentData: {
              segment1: "data1",
              segment2: "data2",
            },
            meta: {
              status: 200,
              headers: { "x-custom": "value" },
              postponed: "postponed-data",
            },
          },
          lastModified: Date.now(),
        });

        const result = await cache.get("key", { kindHint: "app" });

        expect(getIncrementalCache).toHaveBeenCalled();
        expect(result).toEqual({
          value: {
            kind: "APP_PAGE",
            html: "<html></html>",
            rscData: Buffer.from("rsc-data"),
            status: 200,
            headers: { "x-custom": "value" },
            postponed: "postponed-data",
            segmentData: new Map([
              ["segment1", Buffer.from("data1")],
              ["segment2", Buffer.from("data2")],
            ]),
          },
          lastModified: Date.now(),
        });
      });

      // `rsc` is absent from the cache file when the build collected neither a
      // `.rsc` nor a `.prefetch.rsc` file for the entry. Next.js leaves `rscData`
      // undefined for fallback shells and postponed PPR routes as well, see
      // `file-system-cache.ts`, so an undefined value is expected downstream.
      it("Should return an undefined rscData when cache data type is app without rsc (Next 15+)", async () => {
        globalThis.nextVersion = "15.0.0";
        incrementalCache.get.mockResolvedValueOnce({
          value: {
            type: "app",
            html: "<html></html>",
            segmentData: {
              segment1: "data1",
            },
            meta: {
              status: 200,
              postponed: "postponed-data",
            },
          },
          lastModified: Date.now(),
        });

        const result = await cache.get("key", { kindHint: "app" });

        expect(result).toEqual({
          value: {
            kind: "APP_PAGE",
            html: "<html></html>",
            rscData: undefined,
            status: 200,
            headers: undefined,
            postponed: "postponed-data",
            segmentData: new Map([["segment1", Buffer.from("data1")]]),
          },
          lastModified: Date.now(),
        });
        expect((result as any).value.rscData).toBeUndefined();
      });

      it("Should return an empty rscData when cache data type is app with an empty rsc (Next 15+)", async () => {
        globalThis.nextVersion = "15.0.0";
        incrementalCache.get.mockResolvedValueOnce({
          value: {
            type: "app",
            html: "<html></html>",
            rsc: "",
          },
          lastModified: Date.now(),
        });

        const result = await cache.get("key", { kindHint: "app" });

        // An empty `rsc` is a payload of its own, only an absent `rsc` maps to `undefined`.
        expect((result as any).value.rscData).toEqual(Buffer.alloc(0));
      });

      it("Should return null when cache data type is app without html (Next 15+)", async () => {
        globalThis.nextVersion = "15.0.0";
        incrementalCache.get.mockResolvedValueOnce({
          value: {
            type: "app",
            rsc: "rsc-data",
          },
          lastModified: Date.now(),
        });

        const result = await cache.get("key", { kindHint: "app" });

        expect(result).toBeNull();
      });

      it("Should return null when cache data type is page without html", async () => {
        incrementalCache.get.mockResolvedValueOnce({
          value: {
            type: "page",
            json: {},
          },
          lastModified: Date.now(),
        });

        const result = await cache.get("key", { kindHint: "pages" });

        expect(result).toBeNull();
      });

      // On Next.js < 15 an app page is returned as a `PAGE` whose `pageData` holds the RSC
      // payload, there is nothing to return when `rsc` is absent.
      it("Should return null when cache data type is app without rsc (Next 14)", async () => {
        incrementalCache.get.mockResolvedValueOnce({
          value: {
            type: "app",
            html: "<html></html>",
          },
          lastModified: Date.now(),
        });

        const result = await cache.get("key", { kindHint: "app" });

        expect(result).toBeNull();
      });

      it("Should return value when cache data type is redirect", async () => {
        incrementalCache.get.mockResolvedValueOnce({
          value: {
            type: "redirect",
          },
          lastModified: Date.now(),
        });

        const result = await cache.get("key", { kindHint: "app" });

        expect(getIncrementalCache).toHaveBeenCalled();
        expect(result).toEqual({
          value: {
            kind: "REDIRECT",
          },
          lastModified: Date.now(),
        });
      });

      it("Should return null when incremental cache fails", async () => {
        incrementalCache.get.mockRejectedValueOnce(new Error("Error"));

        const result = await cache.get("key", { kindHint: "app" });

        expect(getIncrementalCache).toHaveBeenCalled();
        expect(result).toBeNull();
      });

      describe("stale tags", () => {
        beforeEach(() => {
          globalThis.nextVersion = "16.0.0";
        });

        it("Should set store.lastModified to 1 when tag is stale", async () => {
          tagCache.isStale.mockResolvedValueOnce(true);
          const cachedLastModified = Date.now();
          const store: Record<string, any> = {
            pendingPromiseRunner: {
              withResolvers: vi.fn().mockReturnValue({ resolve: vi.fn() }),
            },
            writtenTags: new Set(),
            requestCache: new RequestCache(),
          };
          (globalThis.__openNextAls.getStore as Mock).mockReturnValue(store);
          incrementalCache.get.mockResolvedValueOnce({
            value: { type: "route", body: "{}" },
            lastModified: cachedLastModified,
          });

          const result = await cache.get("key", { kindHint: "app" });

          expect(result).not.toBeNull();
          expect(result?.lastModified).toEqual(1);
          expect(store.lastModified).toEqual(1);
        });

        it("Should set lastModified to 1 when tag is stale before 16.3", async () => {
          tagCache.isStale.mockResolvedValueOnce(true);
          const store: Record<string, any> = {
            pendingPromiseRunner: {
              withResolvers: vi.fn().mockReturnValue({ resolve: vi.fn() }),
            },
            writtenTags: new Set(),
            requestCache: new RequestCache(),
          };
          (globalThis.__openNextAls.getStore as Mock).mockReturnValue(store);
          incrementalCache.get.mockResolvedValueOnce({
            value: { type: "route", body: "{}", revalidate: 3600 },
            lastModified: Date.now(),
          });

          const result = await cache.get("key", { kindHint: "app" });

          expect(result?.lastModified).toEqual(1);
          expect(store.lastModified).toEqual(1);
        });

        it("Should return a lastModified just past the revalidate window when tag is stale from 16.3", async () => {
          globalThis.nextVersion = "16.3.0";
          tagCache.isStale.mockResolvedValueOnce(true);
          const store: Record<string, any> = {
            pendingPromiseRunner: {
              withResolvers: vi.fn().mockReturnValue({ resolve: vi.fn() }),
            },
            writtenTags: new Set(),
            requestCache: new RequestCache(),
          };
          (globalThis.__openNextAls.getStore as Mock).mockReturnValue(store);
          incrementalCache.get.mockResolvedValueOnce({
            value: { type: "route", body: "{}", revalidate: 3600 },
            lastModified: Date.now(),
          });

          const now = Date.now();
          const result = await cache.get("key", { kindHint: "app" });

          // Stale, but still within the expire window - Next would otherwise force a
          // blocking revalidation (`x-nextjs-cache: REVALIDATED`) from 16.3 on.
          expect(result?.lastModified).toBeGreaterThanOrEqual(
            now - 3600 * 1000 - 1,
          );
          expect(result?.lastModified).toBeLessThan(now - 3599 * 1000);
          // The store keeps the sentinel so that the revalidation queue keeps deduplicating.
          expect(store.lastModified).toEqual(1);
        });

        it("Should set lastModified to 1 from 16.3 when the entry has no revalidate", async () => {
          globalThis.nextVersion = "16.3.0";
          tagCache.isStale.mockResolvedValueOnce(true);
          const store: Record<string, any> = {
            pendingPromiseRunner: {
              withResolvers: vi.fn().mockReturnValue({ resolve: vi.fn() }),
            },
            writtenTags: new Set(),
            requestCache: new RequestCache(),
          };
          (globalThis.__openNextAls.getStore as Mock).mockReturnValue(store);
          incrementalCache.get.mockResolvedValueOnce({
            value: { type: "route", body: "{}" },
            lastModified: Date.now(),
          });

          const result = await cache.get("key", { kindHint: "app" });

          expect(result?.lastModified).toEqual(1);
          expect(store.lastModified).toEqual(1);
        });

        it("Should set store.lastModified to original lastModified when tag is not stale", async () => {
          tagCache.isStale.mockResolvedValueOnce(false);
          const cachedLastModified = Date.now();
          const store: Record<string, any> = {
            pendingPromiseRunner: {
              withResolvers: vi.fn().mockReturnValue({ resolve: vi.fn() }),
            },
            writtenTags: new Set(),
          };
          (globalThis.__openNextAls.getStore as Mock).mockReturnValue(store);
          incrementalCache.get.mockResolvedValueOnce({
            value: { type: "route", body: "{}" },
            lastModified: cachedLastModified,
          });

          await cache.get("key", { kindHint: "app" });

          expect(store.lastModified).toEqual(cachedLastModified);
        });

        it("Should not call isStale when shouldBypassTagCache is true", async () => {
          incrementalCache.get.mockResolvedValueOnce({
            value: { type: "route", body: "{}" },
            lastModified: Date.now(),
            shouldBypassTagCache: true,
          });

          await cache.get("key", { kindHint: "app" });

          expect(tagCache.isStale).not.toHaveBeenCalled();
        });
      });
    });
  });

  describe("set", () => {
    it("Should delete cache when data is undefined", async () => {
      await cache.set("key", undefined);

      expect(incrementalCache.delete).toHaveBeenCalled();
    });

    it("Should set cache when for ROUTE", async () => {
      await cache.set("key", {
        kind: "ROUTE",
        body: Buffer.from("{}"),
        status: 200,
        headers: {},
      });

      expect(incrementalCache.set).toHaveBeenCalledWith(
        "key",
        { type: "route", body: "{}", meta: { status: 200, headers: {} } },
        "cache",
      );
    });

    it("Should set cache when for APP_ROUTE", async () => {
      await cache.set("key", {
        kind: "APP_ROUTE",
        body: Buffer.from("{}"),
        status: 200,
        headers: {
          "content-type": "image/png",
        },
      });

      expect(incrementalCache.set).toHaveBeenCalledWith(
        "key",
        {
          type: "route",
          body: Buffer.from("{}").toString("base64"),
          meta: { status: 200, headers: { "content-type": "image/png" } },
        },
        "cache",
      );
    });

    it("Should set cache when for PAGE", async () => {
      await cache.set("key", {
        kind: "PAGE",
        html: "<html></html>",
        pageData: {},
        status: 200,
        headers: {},
      });

      expect(incrementalCache.set).toHaveBeenCalledWith(
        "key",
        {
          type: "page",
          html: "<html></html>",
          json: {},
        },
        "cache",
      );
    });

    it("Should set cache when for PAGES", async () => {
      await cache.set("key", {
        kind: "PAGES",
        html: "<html></html>",
        pageData: "rsc",
        status: 200,
        headers: {},
      });

      expect(incrementalCache.set).toHaveBeenCalledWith(
        "key",
        {
          type: "app",
          html: "<html></html>",
          rsc: "rsc",
          meta: { status: 200, headers: {} },
        },
        "cache",
      );
    });

    it("Should set cache when for APP_PAGE", async () => {
      await cache.set("key", {
        kind: "APP_PAGE",
        html: "<html></html>",
        rscData: Buffer.from("rsc"),
        status: 200,
        headers: {},
      });

      expect(incrementalCache.set).toHaveBeenCalledWith(
        "key",
        {
          type: "app",
          html: "<html></html>",
          rsc: "rsc",
          meta: { status: 200, headers: {} },
        },
        "cache",
      );
    });

    it("Should set cache when for APP_PAGE with segmentData and postponed", async () => {
      const segmentData = new Map([
        ["segment1", Buffer.from("data1")],
        ["segment2", Buffer.from("data2")],
      ]);

      await cache.set("key", {
        kind: "APP_PAGE",
        html: "<html></html>",
        rscData: Buffer.from("rsc"),
        status: 200,
        headers: { "x-custom": "value" },
        segmentData,
        postponed: "postponed-data",
      });

      expect(incrementalCache.set).toHaveBeenCalledWith(
        "key",
        {
          type: "app",
          html: "<html></html>",
          rsc: "rsc",
          meta: {
            status: 200,
            headers: { "x-custom": "value" },
            postponed: "postponed-data",
          },
          segmentData: {
            segment1: "data1",
            segment2: "data2",
          },
        },
        "cache",
      );
    });

    // `x-next-cache-tags` carries the tags collected during the render, as a comma
    // separated string. Only entries reachable by `revalidateTag` are covered here: an App
    // Router page is a `PAGE` with a string `pageData` before Next 15 and an `APP_PAGE`
    // from Next 15 on. A `PAGE` with an object `pageData` is a Pages Router entry, which
    // `revalidateTag` never reaches.
    it.each([
      {
        cacheKind: "PAGE",
        data: {
          kind: "PAGE" as const,
          html: "<html></html>",
          pageData: "rsc",
          status: 200,
          headers: { "x-next-cache-tags": "existing-tag,new-tag" },
        },
      },
      {
        cacheKind: "APP_PAGE",
        data: {
          kind: "APP_PAGE" as const,
          html: "<html></html>",
          rscData: Buffer.from("rsc"),
          status: 200,
          headers: { "x-next-cache-tags": "existing-tag,new-tag" },
        },
      },
    ])("Should persist cache tags for $cacheKind entries", async ({ data }) => {
      tagCache.getByPath.mockResolvedValueOnce(["existing-tag"]);

      await cache.set("key", data);

      expect(tagCache.getByPath).toHaveBeenCalledWith("key");
      expect(tagCache.writeTags).toHaveBeenCalledTimes(1);
      expect(tagCache.writeTags).toHaveBeenCalledWith([
        {
          path: "key",
          tag: "new-tag",
          revalidatedAt: 1,
        },
      ]);
    });

    it("Should set cache when for APP_PAGE without rscData", async () => {
      await cache.set("key", {
        kind: "APP_PAGE",
        html: "<html></html>",
        rscData: undefined,
        status: 200,
        headers: {},
        postponed: "postponed-data",
      });

      expect(incrementalCache.set).toHaveBeenCalledWith(
        "key",
        {
          type: "app",
          html: "<html></html>",
          rsc: undefined,
          meta: {
            status: 200,
            headers: {},
            postponed: "postponed-data",
          },
        },
        "cache",
      );
      // `toHaveBeenCalledWith` ignores undefined properties, so we assert on the
      // written value to make sure `rsc` is not serialized.
      expect(incrementalCache.set.mock.calls[0][1].rsc).toBeUndefined();
    });

    it("Should set cache when for APP_PAGE with an empty rscData", async () => {
      await cache.set("key", {
        kind: "APP_PAGE",
        html: "<html></html>",
        rscData: Buffer.alloc(0),
        status: 200,
        headers: {},
      });

      expect(incrementalCache.set.mock.calls[0][1].rsc).toEqual("");
    });

    // `get` maps an absent `rsc` to `undefined` and an empty `rsc` to an empty buffer, so
    // both values written here come back unchanged.
    it.each([
      { rscData: undefined, rsc: undefined },
      { rscData: Buffer.alloc(0), rsc: "" },
    ])(
      "Should round-trip an APP_PAGE with rscData: $rscData",
      async ({ rscData, rsc }) => {
        globalThis.nextVersion = "15.0.0";

        await cache.set("key", {
          kind: "APP_PAGE",
          html: "<html></html>",
          rscData,
          status: 200,
          headers: {},
        });

        const written = incrementalCache.set.mock.calls[0][1];
        expect(written.rsc).toEqual(rsc);

        incrementalCache.get.mockResolvedValueOnce({
          value: written,
          lastModified: Date.now(),
        });
        const result = await cache.get("key", { kindHint: "app" });

        expect((result as any).value.rscData).toEqual(rscData);
      },
    );

    it("Should set cache when for FETCH", async () => {
      await cache.set("key", {
        kind: "FETCH",
        data: {
          headers: {},
          body: "{}",
          url: "https://example.com",
          status: 200,
          tags: [],
        },
        revalidate: 60,
      });

      expect(incrementalCache.set).toHaveBeenCalledWith(
        "key",
        {
          kind: "FETCH",
          data: {
            headers: {},
            body: "{}",
            url: "https://example.com",
            status: 200,
            tags: [],
          },
          revalidate: 60,
        },
        "fetch",
      );
    });

    it("Should set cache when for REDIRECT", async () => {
      await cache.set("key", { kind: "REDIRECT", props: {} });

      expect(incrementalCache.set).toHaveBeenCalledWith(
        "key",
        {
          type: "redirect",
          props: {},
        },
        "cache",
      );
    });

    it("Should not set cache when for IMAGE (not implemented)", async () => {
      await cache.set("key", {
        kind: "IMAGE",
        etag: "etag",
        buffer: Buffer.from("hello"),
        extension: "png",
      });

      expect(incrementalCache.set).not.toHaveBeenCalled();
    });

    it("Should not throw when set cache throws", async () => {
      incrementalCache.set.mockRejectedValueOnce(new Error("Error"));

      await expect(
        cache.set("key", { kind: "REDIRECT", props: {} }),
      ).resolves.not.toThrow();
    });

    describe("deferred write", () => {
      const deferredWrite = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        return { promise, resolve };
      };

      // Only the store write is unresolved, so a few ticks are enough for `set` to reach it.
      const drainMicrotasks = async (ticks = 20) => {
        for (let i = 0; i < ticks; i++) {
          await Promise.resolve();
        }
      };

      const useWaitUntil = () => {
        const waitUntil = vi.fn();
        (globalThis.__openNextAls.getStore as Mock).mockReturnValue({
          pendingPromiseRunner: {
            withResolvers: vi.fn().mockReturnValue({ resolve: vi.fn() }),
          },
          waitUntil,
          writtenTags: new Set(),
        });
        return waitUntil;
      };

      it("Should hand the write to waitUntil instead of awaiting it", async () => {
        const waitUntil = useWaitUntil();
        const write = deferredWrite();
        incrementalCache.set.mockReturnValueOnce(write.promise);
        tagCache.getByPath.mockResolvedValueOnce([]);

        let settled = false;
        const set = cache
          .set("key", {
            kind: "APP_PAGE",
            html: "<html></html>",
            rscData: Buffer.from("rsc"),
            status: 200,
            headers: { "x-next-cache-tags": "new-tag" },
          })
          .then(() => {
            settled = true;
          });

        await drainMicrotasks();

        // `set` is done while the write is still pending; the write went to the runtime
        expect(settled).toBe(true);
        expect(incrementalCache.set).toHaveBeenCalled();
        expect(waitUntil).toHaveBeenCalledTimes(1);
        const handedOver = waitUntil.mock.calls[0][0];
        expect(tagCache.getByPath).not.toHaveBeenCalled();

        write.resolve();

        // The tags are only updated once the entry is in the store
        await set;
        await expect(handedOver).resolves.toBeUndefined();
        expect(tagCache.getByPath).toHaveBeenCalledWith("key");
        expect(tagCache.writeTags).toHaveBeenCalledWith([
          { path: "key", tag: "new-tag", revalidatedAt: 1 },
        ]);
        expect(incrementalCache.set.mock.invocationCallOrder[0]).toBeLessThan(
          tagCache.writeTags.mock.invocationCallOrder[0] as number,
        );
      });

      it("Should await the write when waitUntil is not available", async () => {
        const write = deferredWrite();
        incrementalCache.set.mockReturnValueOnce(write.promise);

        let settled = false;
        const set = cache
          .set("key", { kind: "REDIRECT", props: {} })
          .then(() => {
            settled = true;
          });

        await drainMicrotasks();

        expect(incrementalCache.set).toHaveBeenCalled();
        expect(settled).toBe(false);

        write.resolve();

        await set;
        expect(settled).toBe(true);
      });

      it("Should await FETCH writes even when waitUntil is available", async () => {
        const waitUntil = useWaitUntil();
        const write = deferredWrite();
        incrementalCache.set.mockReturnValueOnce(write.promise);

        let settled = false;
        const set = cache
          .set("key", {
            kind: "FETCH",
            data: {
              headers: {},
              body: "{}",
              url: "https://example.com",
              status: 200,
              tags: [],
            },
            revalidate: 60,
          })
          .then(() => {
            settled = true;
          });

        await drainMicrotasks();

        // Next.js releases the fetch cache lock once the write settles
        expect(settled).toBe(false);
        expect(waitUntil).not.toHaveBeenCalled();

        write.resolve();

        await set;
        expect(settled).toBe(true);
      });

      it("Should swallow a failed write instead of rejecting", async () => {
        const waitUntil = useWaitUntil();
        incrementalCache.set.mockRejectedValueOnce(new Error("Error"));

        await expect(
          cache.set("key", { kind: "REDIRECT", props: {} }),
        ).resolves.not.toThrow();

        await expect(waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
        // A failed store write skips the tag update
        expect(tagCache.getByPath).not.toHaveBeenCalled();
      });

      it("Should await the write when there is no request context", async () => {
        (globalThis.__openNextAls.getStore as Mock).mockReturnValue(undefined);
        const write = deferredWrite();
        incrementalCache.set.mockReturnValueOnce(write.promise);

        let settled = false;
        const set = cache
          .set("key", { kind: "REDIRECT", props: {} })
          .then(() => {
            settled = true;
          });

        await drainMicrotasks();

        expect(incrementalCache.set).toHaveBeenCalled();
        expect(settled).toBe(false);

        write.resolve();

        await set;
        expect(settled).toBe(true);
      });
    });
  });

  describe("revalidateTag", () => {
    beforeEach(() => {
      globalThis.openNextConfig.dangerous.disableTagCache = false;
      globalThis.openNextConfig.dangerous.disableIncrementalCache = false;
    });
    it("Should do nothing if disableIncrementalCache is true", async () => {
      globalThis.openNextConfig.dangerous.disableIncrementalCache = true;

      await cache.revalidateTag("tag");

      expect(tagCache.writeTags).not.toHaveBeenCalled();
    });

    it("Should do nothing if disableTagCache is true", async () => {
      globalThis.openNextConfig.dangerous.disableTagCache = true;

      await cache.revalidateTag("tag");

      expect(tagCache.writeTags).not.toHaveBeenCalled();
      // Reset the config
      globalThis.openNextConfig.dangerous.disableTagCache = false;
    });

    it("Should call tagCache.writeTags", async () => {
      tagCache.getByTag.mockResolvedValueOnce(["/path"]);
      await cache.revalidateTag("tag");

      expect(tagCache.getByTag).toHaveBeenCalledWith("tag");

      expect(tagCache.writeTags).toHaveBeenCalledTimes(1);
      expect(tagCache.writeTags).toHaveBeenCalledWith([
        {
          path: "/path",
          tag: "tag",
          expire: Date.now(),
        },
      ]);
    });

    it("Should call invalidateCdnHandler.invalidatePaths", async () => {
      tagCache.getByTag.mockResolvedValueOnce(["/path"]);
      tagCache.getByPath.mockResolvedValueOnce([]);
      await cache.revalidateTag(`${SOFT_TAG_PREFIX}path`);

      expect(tagCache.writeTags).toHaveBeenCalledTimes(1);
      expect(tagCache.writeTags).toHaveBeenCalledWith([
        {
          path: "/path",
          tag: `${SOFT_TAG_PREFIX}path`,
          expire: Date.now(),
        },
      ]);

      expect(invalidateCdnHandler.invalidatePaths).toHaveBeenCalled();
    });

    it("Should not call invalidateCdnHandler.invalidatePaths for fetch cache key ", async () => {
      tagCache.getByTag.mockResolvedValueOnce(["123456"]);
      await cache.revalidateTag("tag");

      expect(tagCache.writeTags).toHaveBeenCalledTimes(1);
      expect(tagCache.writeTags).toHaveBeenCalledWith([
        {
          path: "123456",
          tag: "tag",
          expire: Date.now(),
        },
      ]);

      expect(invalidateCdnHandler.invalidatePaths).not.toHaveBeenCalled();
    });

    it("Should only call writeTags for nextMode", async () => {
      tagCache.mode = "nextMode";
      await cache.revalidateTag(["tag1", "tag2"]);

      expect(tagCache.writeTags).toHaveBeenCalledTimes(1);
      expect(tagCache.writeTags).toHaveBeenCalledWith([
        {
          tag: "tag1",
          expire: Date.now(),
        },
        {
          tag: "tag2",
          expire: Date.now(),
        },
      ]);
      expect(invalidateCdnHandler.invalidatePaths).not.toHaveBeenCalled();
    });

    it("Should not call writeTags when the tag list is empty for nextMode", async () => {
      tagCache.mode = "nextMode";
      await cache.revalidateTag([]);

      expect(tagCache.writeTags).not.toHaveBeenCalled();
      expect(invalidateCdnHandler.invalidatePaths).not.toHaveBeenCalled();
    });

    it("Should call writeTags and invalidateCdnHandler.invalidatePaths for nextMode that supports getPathsByTags", async () => {
      tagCache.mode = "nextMode";
      tagCache.getPathsByTags = vi.fn().mockResolvedValueOnce(["/path"]);
      await cache.revalidateTag("tag");

      expect(tagCache.writeTags).toHaveBeenCalledTimes(1);
      expect(tagCache.writeTags).toHaveBeenCalledWith([
        {
          tag: "tag",
          expire: Date.now(),
        },
      ]);
      expect(invalidateCdnHandler.invalidatePaths).toHaveBeenCalledWith([
        {
          initialPath: "/path",
          rawPath: "/path",
          resolvedRoutes: [
            {
              type: "app",
              route: "/path",
            },
          ],
        },
      ]);
    });

    describe("durations parameter", () => {
      it("Should set stale and expiry when durations.expire is provided - original mode", async () => {
        tagCache.getByTag.mockResolvedValueOnce(["/path"]);
        tagCache.getByPath.mockResolvedValueOnce([]);
        const now = Date.now();

        await cache.revalidateTag("tag", { expire: 60 });

        expect(tagCache.writeTags).toHaveBeenCalledTimes(1);
        expect(tagCache.writeTags).toHaveBeenCalledWith([
          {
            path: "/path",
            tag: "tag",
            stale: now,
            expire: now + 60 * 1000,
          },
        ]);
      });

      it("Should set stale and expiry when durations.expire is provided - nextMode", async () => {
        tagCache.mode = "nextMode";
        const now = Date.now();

        await cache.revalidateTag("tag", { expire: 60 });

        expect(tagCache.writeTags).toHaveBeenCalledTimes(1);
        expect(tagCache.writeTags).toHaveBeenCalledWith([
          {
            tag: "tag",
            stale: now,
            expire: now + 60 * 1000,
          },
        ]);
      });

      it("Should set stale without expiry when durations.expire is undefined", async () => {
        tagCache.mode = "nextMode";
        const now = Date.now();

        await cache.revalidateTag("tag", { expire: undefined });

        expect(tagCache.writeTags).toHaveBeenCalledTimes(1);
        expect(tagCache.writeTags).toHaveBeenCalledWith([
          {
            tag: "tag",
            stale: now,
            expire: undefined,
          },
        ]);
      });

      it("Should handle multiple tags with durations - original mode", async () => {
        tagCache.getByTag
          .mockResolvedValueOnce(["/path1"])
          .mockResolvedValueOnce(["/path2"]);
        const now = Date.now();

        await cache.revalidateTag(["tag1", "tag2"], { expire: 30 });

        expect(tagCache.writeTags).toHaveBeenCalledTimes(2);
        expect(tagCache.writeTags).toHaveBeenNthCalledWith(1, [
          {
            path: "/path1",
            tag: "tag1",
            stale: now,
            expire: now + 30 * 1000,
          },
        ]);
        expect(tagCache.writeTags).toHaveBeenNthCalledWith(2, [
          {
            path: "/path2",
            tag: "tag2",
            stale: now,
            expire: now + 30 * 1000,
          },
        ]);
      });

      it("Should handle multiple tags with durations - nextMode", async () => {
        tagCache.mode = "nextMode";
        const now = Date.now();

        await cache.revalidateTag(["tag1", "tag2"], { expire: 30 });

        expect(tagCache.writeTags).toHaveBeenCalledTimes(1);
        expect(tagCache.writeTags).toHaveBeenCalledWith([
          {
            tag: "tag1",
            stale: now,
            expire: now + 30 * 1000,
          },
          {
            tag: "tag2",
            stale: now,
            expire: now + 30 * 1000,
          },
        ]);
      });

      it("Should set expiry with durations for soft tags - original mode", async () => {
        // Test soft tag without hard tags (simpler case)
        tagCache.getByTag.mockResolvedValueOnce(["/path"]);
        tagCache.getByPath.mockResolvedValueOnce([]); // No hard tags
        const now = Date.now();

        await cache.revalidateTag(`${SOFT_TAG_PREFIX}path`, { expire: 60 });

        expect(tagCache.writeTags).toHaveBeenCalledTimes(1);
        expect(tagCache.writeTags).toHaveBeenCalledWith([
          {
            path: "/path",
            tag: `${SOFT_TAG_PREFIX}path`,
            stale: now,
            expire: now + 60 * 1000,
          },
        ]);
      });

      it("Should handle immediate expiration (expire: 0) - original mode", async () => {
        tagCache.getByTag.mockResolvedValueOnce(["/test-path"]);
        const now = Date.now();

        await cache.revalidateTag("testtag", { expire: 0 });

        expect(tagCache.writeTags).toHaveBeenCalledTimes(1);
        expect(tagCache.writeTags).toHaveBeenCalledWith([
          {
            path: "/test-path",
            tag: "testtag",
            stale: now,
            expire: now,
          },
        ]);
      });

      it("Should handle immediate expiration (expire: 0) - nextMode", async () => {
        tagCache.mode = "nextMode";
        const now = Date.now();

        await cache.revalidateTag("tag", { expire: 0 });

        expect(tagCache.writeTags).toHaveBeenCalledTimes(1);
        expect(tagCache.writeTags).toHaveBeenCalledWith([
          {
            tag: "tag",
            stale: now,
            expire: now,
          },
        ]);
      });
    });
  });

  describe("shouldBypassTagCache", () => {
    describe("fetch cache", () => {
      it("Should bypass tag cache validation when shouldBypassTagCache is true", async () => {
        incrementalCache.get.mockResolvedValueOnce({
          value: {
            kind: "FETCH",
            data: {
              headers: {},
              body: "{}",
              url: "https://example.com",
              status: 200,
            },
          },
          lastModified: Date.now(),
          shouldBypassTagCache: true,
        });

        const result = await cache.get("key", {
          kind: "FETCH",
          tags: ["tag1"],
        });

        expect(getFetchCacheSpy).toHaveBeenCalled();
        expect(tagCache.getLastModified).not.toHaveBeenCalled();
        expect(tagCache.hasBeenRevalidated).not.toHaveBeenCalled();
        expect(result).not.toBeNull();
        expect(result?.value).toEqual({
          kind: "FETCH",
          data: {
            headers: {},
            body: "{}",
            url: "https://example.com",
            status: 200,
          },
        });
      });

      it("Should not bypass tag cache validation when shouldBypassTagCache is false", async () => {
        tagCache.mode = "nextMode";
        incrementalCache.get.mockResolvedValueOnce({
          value: {
            kind: "FETCH",
            data: {
              headers: {},
              body: "{}",
              url: "https://example.com",
              status: 200,
            },
          },
          lastModified: Date.now(),
          shouldBypassTagCache: false,
        });

        const result = await cache.get("key", {
          kind: "FETCH",
          tags: ["tag1"],
        });

        expect(getFetchCacheSpy).toHaveBeenCalled();
        expect(tagCache.hasBeenRevalidated).toHaveBeenCalled();
        expect(result).not.toBeNull();
      });

      it("Should not bypass tag cache validation when shouldBypassTagCache is undefined", async () => {
        tagCache.mode = "nextMode";
        tagCache.hasBeenRevalidated.mockResolvedValueOnce(false);
        incrementalCache.get.mockResolvedValueOnce({
          value: {
            kind: "FETCH",
            data: {
              headers: {},
              body: "{}",
              url: "https://example.com",
              status: 200,
            },
          },
          lastModified: Date.now(),
          // shouldBypassTagCache not set
        });

        const result = await cache.get("key", {
          kind: "FETCH",
          tags: ["tag1"],
        });

        expect(getFetchCacheSpy).toHaveBeenCalled();
        expect(tagCache.hasBeenRevalidated).toHaveBeenCalled();
        expect(result).not.toBeNull();
      });

      it("Should bypass path validation when shouldBypassTagCache is true for soft tags", async () => {
        incrementalCache.get.mockResolvedValueOnce({
          value: {
            kind: "FETCH",
            data: {
              headers: {},
              body: "{}",
              url: "https://example.com",
              status: 200,
            },
          },
          lastModified: Date.now(),
          shouldBypassTagCache: true,
        });

        const result = await cache.get("key", {
          kind: "FETCH",
          softTags: [`${SOFT_TAG_PREFIX}path`],
        });

        expect(getFetchCacheSpy).toHaveBeenCalled();
        expect(tagCache.getLastModified).not.toHaveBeenCalled();
        expect(tagCache.hasBeenRevalidated).not.toHaveBeenCalled();
        expect(result).not.toBeNull();
      });
    });

    describe("incremental cache", () => {
      it("Should bypass tag cache validation when shouldBypassTagCache is true", async () => {
        incrementalCache.get.mockResolvedValueOnce({
          value: {
            type: "route",
            body: "{}",
          },
          lastModified: Date.now(),
          shouldBypassTagCache: true,
        });

        const result = await cache.get("key", { kindHint: "app" });

        expect(getIncrementalCache).toHaveBeenCalled();
        expect(tagCache.getLastModified).not.toHaveBeenCalled();
        expect(tagCache.hasBeenRevalidated).not.toHaveBeenCalled();
        expect(result).not.toBeNull();
        expect(result?.value?.kind).toEqual("ROUTE");
      });

      it("Should not bypass tag cache validation when shouldBypassTagCache is false", async () => {
        tagCache.mode = "nextMode";
        incrementalCache.get.mockResolvedValueOnce({
          value: {
            type: "route",
            body: "{}",
            meta: { headers: { "x-next-cache-tags": "tag" } },
          },
          lastModified: Date.now(),
          shouldBypassTagCache: false,
        });

        const result = await cache.get("key", { kindHint: "app" });

        expect(getIncrementalCache).toHaveBeenCalled();
        expect(tagCache.hasBeenRevalidated).toHaveBeenCalled();
        expect(result).not.toBeNull();
      });

      it("Should return null when tag cache indicates revalidation and shouldBypassTagCache is false", async () => {
        tagCache.mode = "nextMode";
        tagCache.hasBeenRevalidated.mockResolvedValueOnce(true);
        incrementalCache.get.mockResolvedValueOnce({
          value: {
            type: "route",
            body: "{}",
            meta: { headers: { "x-next-cache-tags": "tag" } },
          },
          lastModified: Date.now(),
          shouldBypassTagCache: false,
        });

        const result = await cache.get("key", { kindHint: "app" });

        expect(getIncrementalCache).toHaveBeenCalled();
        expect(tagCache.hasBeenRevalidated).toHaveBeenCalled();
        expect(result).toBeNull();
      });

      it("Should return value when tag cache indicates revalidation but shouldBypassTagCache is true", async () => {
        incrementalCache.get.mockResolvedValueOnce({
          value: {
            type: "route",
            body: "{}",
          },
          lastModified: Date.now(),
          shouldBypassTagCache: true,
        });

        const result = await cache.get("key", { kindHint: "app" });

        expect(getIncrementalCache).toHaveBeenCalled();
        expect(tagCache.getLastModified).not.toHaveBeenCalled();
        expect(tagCache.hasBeenRevalidated).not.toHaveBeenCalled();
        expect(result).not.toBeNull();
        expect(result?.value?.kind).toEqual("ROUTE");
      });
    });
  });
});
