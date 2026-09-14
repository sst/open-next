import { patchCode } from "@opennextjs/aws/build/patch/astCodePatcher.js";
import { rule } from "@opennextjs/aws/build/patch/patches/patchBackgroundRevalidation.js";
import { describe, it } from "vitest";

const codeToPatch = `if (cachedResponse && !isOnDemandRevalidate) {
                    var _cachedResponse_value;
                    if (((_cachedResponse_value = cachedResponse.value) == null ? void 0 : _cachedResponse_value.kind) === _types.CachedRouteKind.FETCH) {
                        throw new Error(\`invariant: unexpected cachedResponse of kind fetch in response cache\`);
                    }
                    resolve({
                        ...cachedResponse,
                        revalidate: cachedResponse.curRevalidate
                    });
                    resolved = true;
                    if (!cachedResponse.isStale || context.isPrefetch) {
                        // The cached value is still valid, so we don't need
                        // to update it yet.
                        return null;
                    }
                }`;

// Next 16 renamed the local from `cachedResponse` to
// `previousIncrementalCacheEntry` and added the `isStale !== -1` guard.
const codeToPatchNext16 = `if (previousIncrementalCacheEntry && !context.isOnDemandRevalidate && previousIncrementalCacheEntry.isStale !== -1) {
                    resolve(previousIncrementalCacheEntry);
                    resolved = true;
                    if (!previousIncrementalCacheEntry.isStale || context.isPrefetch) {
                        // The cached value is still valid, so we don't need to update it yet.
                        return previousIncrementalCacheEntry;
                    }
                }`;

describe("patchBackgroundRevalidation", () => {
  it("Should patch code", () => {
    expect(
      patchCode(codeToPatch, rule),
    ).toMatchInlineSnapshot(`"if (cachedResponse && !isOnDemandRevalidate) {
                    var _cachedResponse_value;
                    if (((_cachedResponse_value = cachedResponse.value) == null ? void 0 : _cachedResponse_value.kind) === _types.CachedRouteKind.FETCH) {
                        throw new Error(\`invariant: unexpected cachedResponse of kind fetch in response cache\`);
                    }
                    resolve({
                        ...cachedResponse,
                        revalidate: cachedResponse.curRevalidate
                    });
                    resolved = true;
                    if (true) {
                        // The cached value is still valid, so we don't need
                        // to update it yet.
                        return null;
                    }
                }"`);
  });

  it("Should patch code on Next 16", () => {
    expect(
      patchCode(codeToPatchNext16, rule),
    ).toMatchInlineSnapshot(`"if (previousIncrementalCacheEntry && !context.isOnDemandRevalidate && previousIncrementalCacheEntry.isStale !== -1) {
                    resolve(previousIncrementalCacheEntry);
                    resolved = true;
                    if (true) {
                        // The cached value is still valid, so we don't need to update it yet.
                        return previousIncrementalCacheEntry;
                    }
                }"`);
  });

  it("Should not match the outer `isStale !== -1` guard", () => {
    // The guard must survive: it is what makes Next fall through to a blocking
    // revalidation for entries that are past their `expire`.
    expect(patchCode(codeToPatchNext16, rule)).toContain(
      "previousIncrementalCacheEntry.isStale !== -1",
    );
  });
});
