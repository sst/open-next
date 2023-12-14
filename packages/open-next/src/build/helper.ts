import fs from "node:fs";
import { createRequire as topLevelCreateRequire } from "node:module";
import path from "node:path";
import url from "node:url";

import {
  build as buildAsync,
  BuildOptions as ESBuildOptions,
  buildSync,
} from "esbuild";
import { BuildOptions } from "types/open-next.js";

import logger from "../logger.js";

const require = topLevelCreateRequire(import.meta.url);
const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

export type Options = ReturnType<typeof normalizeOptions>;

export function normalizeOptions(opts: BuildOptions, root: string) {
  const appPath = path.join(process.cwd(), opts.appPath || ".");
  const buildOutputPath = path.join(process.cwd(), opts.buildOutputPath || ".");
  const outputDir = path.join(buildOutputPath, ".open-next");

  let nextPackageJsonPath: string;
  if (opts.packageJsonPath) {
    const _pkgPath = path.join(process.cwd(), opts.packageJsonPath);
    nextPackageJsonPath = _pkgPath.endsWith("package.json")
      ? _pkgPath
      : path.join(_pkgPath, "./package.json");
  } else {
    nextPackageJsonPath = findNextPackageJsonPath(appPath, root);
  }
  return {
    openNextVersion: getOpenNextVersion(),
    nextVersion: getNextVersion(nextPackageJsonPath),
    nextPackageJsonPath,
    appPath,
    appBuildOutputPath: buildOutputPath,
    appPublicPath: path.join(appPath, "public"),
    outputDir,
    tempDir: path.join(outputDir, ".build"),
    minify:
      opts.default.minify ?? Boolean(process.env.OPEN_NEXT_MINIFY) ?? false,
    debug: opts.default.debug ?? Boolean(process.env.OPEN_NEXT_DEBUG) ?? false,
    buildCommand: opts.buildCommand,
    dangerous: opts.dangerous,
    externalMiddleware: opts.middleware?.external ?? false,
    monorepoRoot: root,
  };
}

function findNextPackageJsonPath(appPath: string, root: string) {
  // This is needed for the case where the app is a single-version monorepo and the package.json is in the root of the monorepo
  return fs.existsSync(path.join(appPath, "./package.json"))
    ? path.join(appPath, "./package.json")
    : path.join(root, "./package.json");
}

export function esbuildSync(esbuildOptions: ESBuildOptions, options: Options) {
  const { openNextVersion, debug } = options;
  const result = buildSync({
    target: "esnext",
    format: "esm",
    platform: "node",
    bundle: true,
    minify: debug ? false : true,
    mainFields: ["module", "main"],
    sourcemap: debug ? "inline" : false,
    sourcesContent: false,
    ...esbuildOptions,
    external: ["./open-next.config.js", ...(esbuildOptions.external ?? [])],
    banner: {
      ...esbuildOptions.banner,
      js: [
        esbuildOptions.banner?.js || "",
        `globalThis.openNextDebug = ${debug};`,
        `globalThis.openNextVersion = "${openNextVersion}";`,
      ].join(""),
    },
  });

  if (result.errors.length > 0) {
    result.errors.forEach((error) => logger.error(error));
    throw new Error(
      `There was a problem bundling ${
        (esbuildOptions.entryPoints as string[])[0]
      }.`,
    );
  }
}

export async function esbuildAsync(
  esbuildOptions: ESBuildOptions,
  options: Options,
) {
  const { openNextVersion, debug } = options;
  const result = await buildAsync({
    target: "esnext",
    format: "esm",
    platform: "node",
    bundle: true,
    minify: debug ? false : true,
    mainFields: ["module", "main"],
    sourcemap: debug ? "inline" : false,
    sourcesContent: false,
    ...esbuildOptions,
    external: [
      ...(esbuildOptions.external ?? []),
      "next",
      "./open-next.config.js",
    ],
    banner: {
      ...esbuildOptions.banner,
      js: [
        esbuildOptions.banner?.js || "",
        `globalThis.openNextDebug = ${debug};`,
        `globalThis.openNextVersion = "${openNextVersion}";`,
      ].join(""),
    },
  });

  if (result.errors.length > 0) {
    result.errors.forEach((error) => logger.error(error));
    throw new Error(
      `There was a problem bundling ${
        (esbuildOptions.entryPoints as string[])[0]
      }.`,
    );
  }
}

export function removeFiles(
  root: string,
  conditionFn: (file: string) => boolean,
  searchingDir: string = "",
) {
  traverseFiles(
    root,
    conditionFn,
    (filePath) => fs.rmSync(filePath, { force: true }),
    searchingDir,
  );
}

export function traverseFiles(
  root: string,
  conditionFn: (file: string) => boolean,
  callbackFn: (filePath: string) => void,
  searchingDir: string = "",
) {
  fs.readdirSync(path.join(root, searchingDir)).forEach((file) => {
    const filePath = path.join(root, searchingDir, file);

    if (fs.statSync(filePath).isDirectory()) {
      traverseFiles(
        root,
        conditionFn,
        callbackFn,
        path.join(searchingDir, file),
      );
      return;
    }

    if (conditionFn(path.join(searchingDir, file))) {
      callbackFn(filePath);
    }
  });
}

export function getHtmlPages(dotNextPath: string) {
  // Get a list of HTML pages
  //
  // sample return value:
  // Set([
  //   '404.html',
  //   'csr.html',
  //   'image-html-tag.html',
  // ])
  const manifestPath = path.join(
    dotNextPath,
    ".next/server/pages-manifest.json",
  );
  const manifest = fs.readFileSync(manifestPath, "utf-8");
  return Object.entries(JSON.parse(manifest))
    .filter(([_, value]) => (value as string).endsWith(".html"))
    .map(([_, value]) => (value as string).replace(/^pages\//, ""))
    .reduce((acc, page) => {
      acc.add(page);
      return acc;
    }, new Set<string>());
}

export function getBuildId(dotNextPath: string) {
  return fs
    .readFileSync(path.join(dotNextPath, ".next/BUILD_ID"), "utf-8")
    .trim();
}

export function getOpenNextVersion() {
  return require(path.join(__dirname, "../../package.json")).version;
}

export function getNextVersion(nextPackageJsonPath: string) {
  const version = require(nextPackageJsonPath)?.dependencies?.next;
  // require('next/package.json').version

  if (!version) {
    throw new Error("Failed to find Next version");
  }

  // Drop the -canary.n suffix
  return version.split("-")[0];
}

export function compareSemver(v1: string, v2: string): number {
  if (v1 === "latest") return 1;
  if (/^[^\d]/.test(v1)) {
    v1 = v1.substring(1);
  }
  if (/^[^\d]/.test(v2)) {
    v2 = v2.substring(1);
  }
  const [major1, minor1, patch1] = v1.split(".").map(Number);
  const [major2, minor2, patch2] = v2.split(".").map(Number);

  if (major1 !== major2) return major1 - major2;
  if (minor1 !== minor2) return minor1 - minor2;
  return patch1 - patch2;
}
