---
"@opennextjs/aws": patch
---

Fix broken symlink recreation in `copyTracedFiles` on Windows

On Windows, recreating pnpm directory symlinks from the raw `readlinkSync` value produced file-type symlinks pointing at directories (Node falls back to `type: "file"` when the target does not exist yet), which esbuild could not traverse ("Cannot read directory ...: Access is denied"). Directory links are now recreated as junctions whose target is resolved against the destination's parent directory, matching the semantics of the relative symlink on Linux.
