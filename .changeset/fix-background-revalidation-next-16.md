---
"@opennextjs/aws": patch
---

Fix `patchBackgroundRevalidation` silently no-opping on Next.js 16

The patch's ast-grep rule matched the unary expression `!cachedResponse.isStale`,
but Next.js 16.0.0 renamed that local to `previousIncrementalCacheEntry`. The rule
matched nothing, so `commitEdits([])` returned the source unchanged and the patch
was skipped on every Next.js 16 build — while still being reported as applied in
the `OPEN_NEXT_DEBUG` output, since the log line is emitted before the edit is
attempted.

The rule now matches `!$ENTRY.isStale` instead of hardcoding the identifier, which
keeps working on Next.js 14 and 15 and fixes 16. The existing unit test used a
frozen pre-16 snippet as its fixture, so it kept passing throughout; a Next 16
fixture has been added alongside it, plus an assertion that the outer
`isStale !== -1` guard introduced in 16 is not matched by mistake.
