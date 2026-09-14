---
"@opennextjs/aws": patch
---

`copyTracedFiles`: only register a traced file as a node package when its
basename is exactly `package.json`, not when its filename merely ends with
`package.json` (e.g. `care-package.json`). The previous suffix-only check
caused harmless but noisy `Failed to copy <dir>` errors in the Cloudflare
adapter's workerd-package copy step whenever a project traced a JSON data
file whose name happened to end in `-package.json`.
