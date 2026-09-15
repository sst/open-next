---
"@opennextjs/aws": patch
---

fix: defer incremental cache writes so they do not block the response

`Cache.set` awaited the store write and the tag update, so both landed in the TTFB. Next.js
awaits `incrementalCache.set` in `response-cache/index.js` while it produces the response and
does not use the returned value.

When the wrapper provides a `waitUntil` (the cloudflare wrappers do), the write is now handed
to it instead of being awaited, so it no longer extends the response. Writes that cannot be
deferred safely still block: no `waitUntil`, no request context, and `FETCH` entries, because
Next.js releases its fetch cache lock once the write has settled and a concurrent fetch for
the same key would then read the store before the entry is there.

Errors are still caught and logged, and the tag update still runs after the entry is written.
