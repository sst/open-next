import { getCrossPlatformPathRegex } from "utils/regex.js";
import { createPatchCode } from "../astCodePatcher.js";
import type { CodePatcher } from "../codePatcher.js";

export const rule = `
rule:
  kind: binary_expression
  all:
    - has:
        kind: unary_expression
        pattern: "!$ENTRY.isStale"
    -  has:
         kind: member_expression
         regex: "context.isPrefetch"
fix:
  'true'`;

export const patchBackgroundRevalidation = {
  name: "patchBackgroundRevalidation",
  patches: [
    {
      // TODO: test for earlier versions of Next
      versions: ">=14.1.0",
      pathFilter: getCrossPlatformPathRegex("server/response-cache/index.js"),
      patchCode: createPatchCode(rule),
    },
  ],
} satisfies CodePatcher;
