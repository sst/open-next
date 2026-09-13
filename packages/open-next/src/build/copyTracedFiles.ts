import url from "node:url";

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  loadAppPathsManifest,
  loadBuildId,
  loadConfig,
  loadFunctionsConfigManifest,
  loadMiddlewareManifest,
  loadPagesManifest,
  loadPrerenderManifest,
} from "config/util.js";
import { getCrossPlatformPathRegex } from "utils/regex.js";
import logger from "../logger.js";
import {
  INSTRUMENTATION_TRACE_FILE,
  MIDDLEWARE_TRACE_FILE,
} from "./constant.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

/**
 * Copies a file and ensures the destination is writable.
 * This is necessary because copyFileSync preserves file permissions,
 * and source files may be read-only (e.g., in Bazel's node_modules).
 * Without this, subsequent patches would fail with EACCES errors.
 */
export function copyFileAndMakeOwnerWritable(src: string, dest: string): void {
  copyFileSync(src, dest);
  // Ensure the copied file is writable (add owner write permission)
  const stats = statSync(dest);
  if (!(stats.mode & 0o200)) {
    chmodSync(dest, stats.mode | 0o200);
  }
}

//TODO: we need to figure which packages we could safely remove
const EXCLUDED_PACKAGES = [
  "caniuse-lite",
  "sharp",
  // This seems to be only in Next 15
  // Some of sharp deps are under the @img scope
  "@img",
  "typescript",
  "next/dist/compiled/babel",
  "next/dist/compiled/babel-packages",
  "next/dist/compiled/amphtml-validator",
];

export function isExcluded(srcPath: string): boolean {
  return EXCLUDED_PACKAGES.some((excluded) =>
    // `pnpm` can create a symbolic link that points to the pnpm store folder
    // This will live under `/node_modules/sharp`. We need to handle this in our regex
    srcPath.match(
      getCrossPlatformPathRegex(`/node_modules/${excluded}(?:/|$)`, {
        escape: false,
      }),
    ),
  );
}

const NON_LINUX_PLATFORMS = ["darwin", "win32", "freebsd"];

const platformPattern = NON_LINUX_PLATFORMS.join("|");
const nonLinuxPlatformRegex = getCrossPlatformPathRegex(
  `/node_modules/(?:@[^/]+/)?(?:[^/]+-)?(${platformPattern})-[^/]+/`,
  { escape: false },
);

export function isNonLinuxPlatformPackage(srcPath: string): boolean {
  return nonLinuxPlatformRegex.test(srcPath);
}

function copyPatchFile(outputDir: string) {
  const patchFile = path.join(__dirname, "patch", "patchedAsyncStorage.js");
  const outputPatchFile = path.join(outputDir, "patchedAsyncStorage.cjs");
  copyFileAndMakeOwnerWritable(patchFile, outputPatchFile);
}

interface CopyTracedFilesOptions {
  buildOutputPath: string;
  packagePath: string;
  outputDir: string;
  routes: string[];
  bundledNextServer: boolean;
  skipServerFiles?: boolean;
}

export function getManifests(nextDir: string) {
  return {
    buildId: loadBuildId(nextDir),
    config: loadConfig(nextDir),
    prerenderManifest: loadPrerenderManifest(nextDir),
    pagesManifest: loadPagesManifest(nextDir),
    appPathsManifest: loadAppPathsManifest(nextDir),
    middlewareManifest: loadMiddlewareManifest(nextDir),
    functionsConfigManifest: loadFunctionsConfigManifest(nextDir),
  };
}

// eslint-disable-next-line sonarjs/cognitive-complexity
export async function copyTracedFiles({
  buildOutputPath,
  packagePath,
  outputDir,
  routes,
  bundledNextServer,
  skipServerFiles,
}: CopyTracedFilesOptions) {
  const tsStart = Date.now();
  const dotNextDir = path.join(buildOutputPath, ".next");
  const standaloneDir = path.join(dotNextDir, "standalone");
  const standaloneNextDir = path.join(standaloneDir, packagePath, ".next");
  const standaloneServerDir = path.join(standaloneNextDir, "server");
  const outputNextDir = path.join(outputDir, packagePath, ".next");

  // Files to copy
  // Map from files in the `.next/standalone` to files in the `.open-next` folder
  const filesToCopy = new Map<string, string>();

  // Node packages
  // Map from folders in the project to folders in the `.open-next` folder
  // The map might also include the mono-repo path.
  const nodePackages = new Map<string, string>();

  /**
   * Extracts files and node packages from a .nft.json file
   * @param nftFile path to the .nft.json file relative to `.next/`
   */
  const processNftFile = (nftFile: string) => {
    const subDir = path.dirname(nftFile);
    const files: string[] = JSON.parse(
      readFileSync(path.join(dotNextDir, nftFile), "utf8"),
    ).files;

    files.forEach((tracedPath: string) => {
      const src = path.join(standaloneNextDir, subDir, tracedPath);
      const dst = path.join(outputNextDir, subDir, tracedPath);
      filesToCopy.set(src, dst);

      const module = path.join(dotNextDir, subDir, tracedPath);
      if (module.endsWith("package.json")) {
        nodePackages.set(path.dirname(module), path.dirname(dst));
      }
    });
  };

  // Files necessary by the server
  if (!skipServerFiles) {
    // On next 14+, we might not have to include those files
    // For next 13, we need to include them otherwise we get runtime error
    const nftFile = bundledNextServer
      ? "next-minimal-server.js.nft.json"
      : "next-server.js.nft.json";

    processNftFile(nftFile);
  }
  // create directory for pages
  if (existsSync(path.join(standaloneNextDir, "server/pages"))) {
    mkdirSync(path.join(outputNextDir, "server/pages"), {
      recursive: true,
    });
  }
  if (existsSync(path.join(standaloneNextDir, "server/app"))) {
    mkdirSync(path.join(outputNextDir, "server/app"), {
      recursive: true,
    });
  }

  mkdirSync(path.join(outputNextDir, "server/chunks"), {
    recursive: true,
  });

  const computeCopyFilesForPage = (pagePath: string) => {
    const serverPath = `server/${pagePath}.js`;

    try {
      processNftFile(`${serverPath}.nft.json`);
    } catch (e) {
      if (existsSync(path.join(dotNextDir, serverPath))) {
        //TODO: add a link to the docs
        throw new Error(
          `
--------------------------------------------------------------------------------
${pagePath} cannot use the edge runtime.
OpenNext requires edge runtime function to be defined in a separate function.
See the docs for more information on how to bundle edge runtime functions.
--------------------------------------------------------------------------------
        `,
        );
      }
      throw new Error(`
--------------------------------------------------------------------------------
We cannot find the route for ${pagePath}.
File ${serverPath} does not exist
--------------------------------------------------------------------------------`);
    }

    if (!existsSync(path.join(standaloneNextDir, serverPath))) {
      throw new Error(
        `This error should only happen for static 404 and 500 page from page router. Report this if that's not the case.,
        File ${serverPath} does not exist`,
      );
    }

    filesToCopy.set(
      path.join(standaloneNextDir, serverPath),
      path.join(outputNextDir, serverPath),
    );
  };

  const safeComputeCopyFilesForPage = (
    pagePath: string,
    alternativePath?: string,
  ) => {
    try {
      computeCopyFilesForPage(pagePath);
    } catch (e) {
      if (alternativePath) {
        safeComputeCopyFilesForPage(alternativePath);
      }
    }
  };

  // Check for instrumentation trace file
  if (existsSync(path.join(dotNextDir, INSTRUMENTATION_TRACE_FILE))) {
    // We still need to copy the nft.json file so that computeCopyFilesForPage doesn't throw
    copyFileAndMakeOwnerWritable(
      path.join(dotNextDir, INSTRUMENTATION_TRACE_FILE),
      path.join(standaloneNextDir, INSTRUMENTATION_TRACE_FILE),
    );
    // Next 16's standalone output no longer includes `server/instrumentation.js`
    // in the standalone dir, but `computeCopyFilesForPage` asserts it exists
    // there. Copy it from the build dir (mirroring the .nft.json copy above) so
    // the assertion passes and the instrumentation file ships in the bundle.
    const instrumentationServerFile = path.join("server", "instrumentation.js");
    if (
      existsSync(path.join(dotNextDir, instrumentationServerFile)) &&
      !existsSync(path.join(standaloneNextDir, instrumentationServerFile))
    ) {
      copyFileAndMakeOwnerWritable(
        path.join(dotNextDir, instrumentationServerFile),
        path.join(standaloneNextDir, instrumentationServerFile),
      );
    }
    computeCopyFilesForPage("instrumentation");
    logger.debug("Adding instrumentation trace files");
  }

  if (existsSync(path.join(dotNextDir, MIDDLEWARE_TRACE_FILE))) {
    // We still need to copy the nft.json file so that computeCopyFilesForPage doesn't throw
    copyFileAndMakeOwnerWritable(
      path.join(dotNextDir, MIDDLEWARE_TRACE_FILE),
      path.join(standaloneNextDir, MIDDLEWARE_TRACE_FILE),
    );
    computeCopyFilesForPage("middleware");
    logger.debug("Adding node middleware trace files");
  }

  const hasPageDir = routes.some((route) => route.startsWith("pages/"));
  const hasAppDir = routes.some((route) => route.startsWith("app/"));

  // We need to copy all the base files like _app, _document, _error, etc
  // One thing to note, is that next try to load every routes that might be needed in advance
  // So if you have a [slug].tsx at the root, this route will always be loaded for 1st level request
  // along with _app and _document
  if (hasPageDir) {
    //Page dir
    computeCopyFilesForPage("pages/_app");
    computeCopyFilesForPage("pages/_document");
    computeCopyFilesForPage("pages/_error");

    // These files can be present or not depending on if the user uses getStaticProps
    safeComputeCopyFilesForPage("pages/404");
    safeComputeCopyFilesForPage("pages/500");
  }

  if (hasAppDir) {
    //App dir
    // In next 14.2.0, _not-found is at 'app/_not-found/page'
    safeComputeCopyFilesForPage("app/_not-found", "app/_not-found/page");
  }

  //Files we actually want to include
  routes.forEach((route) => {
    computeCopyFilesForPage(route);
  });

  // Only files that are actually copied
  const tracedFiles: string[] = [];
  const erroredFiles: string[] = [];
  //Actually copy the files
  const skippedPlatformPackages = new Set<string>();
  filesToCopy.forEach((to, from) => {
    // We don't want to copy excluded packages (e.g. sharp)
    if (isExcluded(from)) {
      return;
    }
    // Skip non-Linux platform-specific native binaries (e.g. @swc/core-darwin-arm64)
    // Set OPEN_NEXT_SKIP_PLATFORM_FILTER=true to bypass this check
    if (
      !process.env.OPEN_NEXT_SKIP_PLATFORM_FILTER &&
      isNonLinuxPlatformPackage(from)
    ) {
      const match = from.match(
        /node_modules\/(?:\.pnpm\/.*\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/,
      );
      if (match) {
        skippedPlatformPackages.add(match[1]);
      }
      return;
    }
    tracedFiles.push(to);
    mkdirSync(path.dirname(to), { recursive: true });
    let symlink = null;
    // For pnpm symlink we need to do that
    // see https://github.com/vercel/next.js/blob/498f342b3552d6fc6f1566a1cc5acea324ce0dec/packages/next/src/build/utils.ts#L1932
    try {
      symlink = readlinkSync(from);
    } catch (e) {
      //Ignore
    }
    if (symlink) {
      try {
        if (process.platform === "win32") {
          // On Windows, recreating the link from the raw readlink value breaks:
          // `symlinkSync` without a `type` autodetects from the target, and when
          // the target does not exist yet (common here, since entries are copied
          // in traversal order) it falls back to a *file*-type symlink pointing
          // at a directory, which Windows cannot traverse (esbuild later fails
          // with "Cannot read directory ...: Access is denied").
          // Instead, create a junction whose target is the raw value resolved
          // against the destination's parent directory — semantically identical
          // to what the relative symlink means on Linux (it points into the
          // mirrored output structure). Junctions only apply to directories
          // (every pnpm link recreated here is one), need no admin rights or
          // Developer Mode, and resolve lazily once the target is populated.
          const rawTarget = symlink.startsWith("\\\\?\\")
            ? symlink.slice(4)
            : symlink;
          const target = path.isAbsolute(rawTarget)
            ? rawTarget
            : path.resolve(path.dirname(to), rawTarget);
          symlinkSync(target, to, "junction");
        } else {
          symlinkSync(symlink, to);
        }
      } catch (e: any) {
        if (e.code !== "EEXIST") {
          throw e;
        }
      }
    } else {
      // Adding this inside a try-catch to handle errors on Next 16+
      // where some files listed in the .nft.json might not be present in the standalone folder
      // TODO: investigate that further - is it expected?
      try {
        copyFileAndMakeOwnerWritable(from, to);
      } catch (e) {
        logger.debug("Error copying file:", e);
        erroredFiles.push(to);
      }
    }
  });

  if (skippedPlatformPackages.size > 0) {
    logger.debug(
      "Skipped non-Linux platform packages:",
      [...skippedPlatformPackages].join(", "),
    );
  }

  readdirSync(standaloneNextDir)
    .filter(
      (fileOrDir) =>
        !statSync(path.join(standaloneNextDir, fileOrDir)).isDirectory(),
    )
    .forEach((file) => {
      copyFileAndMakeOwnerWritable(
        path.join(standaloneNextDir, file),
        path.join(outputNextDir, file),
      );
      tracedFiles.push(path.join(outputNextDir, file));
    });

  // We then need to copy all the files at the root of server

  mkdirSync(path.join(outputNextDir, "server"), { recursive: true });

  readdirSync(standaloneServerDir)
    .filter(
      (fileOrDir) =>
        !statSync(path.join(standaloneServerDir, fileOrDir)).isDirectory(),
    )
    .filter((file) => file !== "server.js")
    .forEach((file) => {
      copyFileAndMakeOwnerWritable(
        path.join(standaloneServerDir, file),
        path.join(path.join(outputNextDir, "server"), file),
      );
      tracedFiles.push(path.join(outputNextDir, "server", file));
    });

  // Copy patch file
  copyPatchFile(path.join(outputDir, packagePath));

  // TODO: Recompute all the files.
  // vercel doesn't seem to do it, but it seems wasteful to have all those files
  // we replace the pages-manifest.json with an empty one if we don't have a pages dir so that
  // next doesn't try to load _app, _document
  if (!hasPageDir) {
    writeFileSync(path.join(outputNextDir, "server/pages-manifest.json"), "{}");
  }

  //TODO: Find what else we need to copy
  const copyStaticFile = (filePath: string) => {
    if (existsSync(path.join(standaloneNextDir, filePath))) {
      mkdirSync(path.dirname(path.join(outputNextDir, filePath)), {
        recursive: true,
      });
      copyFileAndMakeOwnerWritable(
        path.join(standaloneNextDir, filePath),
        path.join(outputNextDir, filePath),
      );
    }
  };

  const manifests = getManifests(standaloneNextDir);
  const { config, prerenderManifest, pagesManifest } = manifests;

  // Get all the static files - Should be only for pages dir
  // Ideally we would filter only those that might get accessed in this specific functions
  // Maybe even move this to s3 directly
  if (hasPageDir) {
    // First we get truly static files - i.e. pages without getStaticProps
    const staticFiles: Array<string> = Object.values(pagesManifest);
    // Then we need to get all fallback: true dynamic routes html
    const locales = config.i18n?.locales;
    Object.values(prerenderManifest?.dynamicRoutes ?? {}).forEach((route) => {
      if (typeof route.fallback === "string") {
        if (locales) {
          locales.forEach((locale) => {
            staticFiles.push(`pages/${locale}${route.fallback}`);
          });
        } else {
          staticFiles.push(`pages${route.fallback}`);
        }
      }
    });

    staticFiles
      .filter((file) => file.endsWith(".html"))
      .forEach((file) => copyStaticFile(`server/${file}`));
  }

  // Copy .next/static/css from standalone to output dir
  // needed for optimizeCss feature to work
  if (config.experimental.optimizeCss) {
    cpSync(
      path.join(standaloneNextDir, "static", "css"),
      path.join(outputNextDir, "static", "css"),
      { recursive: true },
    );
  }

  logger.debug("copyTracedFiles:", Date.now() - tsStart, "ms");

  return {
    tracedFiles: tracedFiles.filter((f) => !erroredFiles.includes(f)),
    nodePackages,
    manifests,
  };
}
