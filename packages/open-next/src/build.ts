import cp from "node:child_process";
import fs, { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import { buildSync } from "esbuild";
import { MiddlewareManifest } from "types/next-types.js";

import { createServerBundle } from "./build/createServerBundle.js";
import { buildEdgeBundle } from "./build/edge/createEdgeBundle.js";
import { generateOutput } from "./build/generateOutput.js";
import {
  esbuildAsync,
  esbuildSync,
  getBuildId,
  getHtmlPages,
  normalizeOptions,
  Options,
  removeFiles,
  traverseFiles,
} from "./build/helper.js";
import logger from "./logger.js";
import { minifyAll } from "./minimize-js.js";
import { openNextResolvePlugin } from "./plugins/resolve.js";
import { BuildOptions } from "./types/open-next.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
let options: Options;

export type PublicFiles = {
  files: string[];
};

export async function build() {
  const outputTmpPath = path.join(process.cwd(), ".open-next", ".build");

  // Compile open-next.config.ts
  createOpenNextConfigBundle(outputTmpPath);

  const config = await import(outputTmpPath + "/open-next.config.js");
  const opts = config.default as BuildOptions;

  const { root: monorepoRoot, packager } = findMonorepoRoot(
    path.join(process.cwd(), opts.appPath || "."),
  );

  // Initialize options
  options = normalizeOptions(opts, monorepoRoot);
  logger.setLevel(options.debug ? "debug" : "info");

  // Pre-build validation
  checkRunningInsideNextjsApp();
  printNextjsVersion();
  printOpenNextVersion();

  // Build Next.js app
  printHeader("Building Next.js app");
  setStandaloneBuildMode(monorepoRoot);
  await buildNextjsApp(packager);

  // Generate deployable bundle
  printHeader("Generating bundle");
  initOutputDir();

  // Compile cache.ts
  compileCache(options);

  // Compile middleware
  await createMiddleware();

  createStaticAssets();
  if (!options.dangerous?.disableIncrementalCache) {
    await createCacheAssets(
      monorepoRoot,
      options.dangerous?.disableDynamoDBCache,
    );
  }
  await createServerBundle(opts, options);
  await createRevalidationBundle();
  createImageOptimizationBundle();
  await createWarmerBundle();
  await generateOutput(options.appBuildOutputPath, opts);
  if (options.minify) {
    await minifyServerBundle();
  }
}

function createOpenNextConfigBundle(tempDir: string) {
  buildSync({
    entryPoints: [path.join(process.cwd(), "open-next.config.ts")],
    outfile: path.join(tempDir, "open-next.config.js"),
    bundle: true,
    format: "cjs",
    target: ["node18"],
  });
}

function checkRunningInsideNextjsApp() {
  const { appPath } = options;
  const extension = ["js", "cjs", "mjs"].find((ext) =>
    fs.existsSync(path.join(appPath, `next.config.${ext}`)),
  );
  if (!extension) {
    logger.error(
      "Error: next.config.js not found. Please make sure you are running this command inside a Next.js app.",
    );
    process.exit(1);
  }
}

function findMonorepoRoot(appPath: string) {
  let currentPath = appPath;
  while (currentPath !== "/") {
    const found = [
      { file: "package-lock.json", packager: "npm" as const },
      { file: "yarn.lock", packager: "yarn" as const },
      { file: "pnpm-lock.yaml", packager: "pnpm" as const },
    ].find((f) => fs.existsSync(path.join(currentPath, f.file)));

    if (found) {
      if (currentPath !== appPath) {
        logger.info("Monorepo detected at", currentPath);
      }
      return { root: currentPath, packager: found.packager };
    }
    currentPath = path.dirname(currentPath);
  }

  // note: a lock file (package-lock.json, yarn.lock, or pnpm-lock.yaml) is
  //       not found in the app's directory or any of its parent directories.
  //       We are going to assume that the app is not part of a monorepo.
  return { root: appPath, packager: "npm" as const };
}

function setStandaloneBuildMode(monorepoRoot: string) {
  // Equivalent to setting `target: "standalone"` in next.config.js
  process.env.NEXT_PRIVATE_STANDALONE = "true";
  // Equivalent to setting `experimental.outputFileTracingRoot` in next.config.js
  process.env.NEXT_PRIVATE_OUTPUT_TRACE_ROOT = monorepoRoot;
}

function buildNextjsApp(packager: "npm" | "yarn" | "pnpm") {
  const { nextPackageJsonPath } = options;
  const command =
    options.buildCommand ??
    (packager === "npm" ? "npm run build" : `${packager} build`);
  cp.execSync(command, {
    stdio: "inherit",
    cwd: path.dirname(nextPackageJsonPath),
  });
}

function printHeader(header: string) {
  header = `OpenNext — ${header}`;
  logger.info(
    [
      "",
      "┌" + "─".repeat(header.length + 2) + "┐",
      `│ ${header} │`,
      "└" + "─".repeat(header.length + 2) + "┘",
      "",
    ].join("\n"),
  );
}

function printNextjsVersion() {
  const { appPath } = options;
  cp.spawnSync(
    "node",
    [
      "-e",
      `"console.info('Next.js v' + require('next/package.json').version)"`,
    ],
    {
      stdio: "inherit",
      cwd: appPath,
      shell: true,
    },
  );
}

function printOpenNextVersion() {
  const { openNextVersion } = options;
  logger.info(`OpenNext v${openNextVersion}`);
}

function initOutputDir() {
  const { outputDir, tempDir } = options;
  const openNextConfig = readFileSync(
    path.join(tempDir, "open-next.config.js"),
    "utf8",
  );
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(path.join(tempDir, "open-next.config.js"), openNextConfig);
}

async function createWarmerBundle() {
  logger.info(`Bundling warmer function...`);

  const { outputDir } = options;

  // Create output folder
  const outputPath = path.join(outputDir, "warmer-function");
  fs.mkdirSync(outputPath, { recursive: true });

  // Copy open-next.config.js into the bundle
  fs.copyFileSync(
    path.join(options.tempDir, "open-next.config.js"),
    path.join(outputPath, "open-next.config.js"),
  );

  // Build Lambda code
  // note: bundle in OpenNext package b/c the adatper relys on the
  //       "serverless-http" package which is not a dependency in user's
  //       Next.js app.
  await esbuildAsync(
    {
      entryPoints: [path.join(__dirname, "adapters", "warmer-function.js")],
      external: ["next"],
      outfile: path.join(outputPath, "index.mjs"),
      plugins: [
        openNextResolvePlugin({
          overrides: {
            converter: "dummy",
          },
        }),
      ],
      banner: {
        js: [
          "import { createRequire as topLevelCreateRequire } from 'module';",
          "const require = topLevelCreateRequire(import.meta.url);",
          "import bannerUrl from 'url';",
          "const __dirname = bannerUrl.fileURLToPath(new URL('.', import.meta.url));",
        ].join(""),
      },
    },
    options,
  );
}

async function minifyServerBundle() {
  logger.info(`Minimizing server function...`);
  const { outputDir } = options;
  await minifyAll(path.join(outputDir, "server-function"), {
    compress_json: true,
    mangle: true,
  });
}

async function createRevalidationBundle() {
  logger.info(`Bundling revalidation function...`);

  const { appBuildOutputPath, outputDir } = options;

  // Create output folder
  const outputPath = path.join(outputDir, "revalidation-function");
  fs.mkdirSync(outputPath, { recursive: true });

  //Copy open-next.config.js into the bundle
  fs.copyFileSync(
    path.join(options.tempDir, "open-next.config.js"),
    path.join(outputPath, "open-next.config.js"),
  );

  // Build Lambda code
  esbuildAsync(
    {
      external: ["next", "styled-jsx", "react"],
      entryPoints: [path.join(__dirname, "adapters", "revalidate.js")],
      outfile: path.join(outputPath, "index.mjs"),
      plugins: [
        openNextResolvePlugin({
          overrides: {
            converter: "sqs-revalidate",
          },
        }),
      ],
    },
    options,
  );

  // Copy over .next/prerender-manifest.json file
  fs.copyFileSync(
    path.join(appBuildOutputPath, ".next", "prerender-manifest.json"),
    path.join(outputPath, "prerender-manifest.json"),
  );
}

function createImageOptimizationBundle() {
  logger.info(`Bundling image optimization function...`);

  const { appPath, appBuildOutputPath, outputDir } = options;

  // Create output folder
  const outputPath = path.join(outputDir, "image-optimization-function");
  fs.mkdirSync(outputPath, { recursive: true });

  // Copy open-next.config.js into the bundle
  fs.copyFileSync(
    path.join(options.tempDir, "open-next.config.js"),
    path.join(outputPath, "open-next.config.js"),
  );

  // Build Lambda code (1st pass)
  // note: bundle in OpenNext package b/c the adapter relies on the
  //       "@aws-sdk/client-s3" package which is not a dependency in user's
  //       Next.js app.
  esbuildSync(
    {
      entryPoints: [
        path.join(__dirname, "adapters", "image-optimization-adapter.js"),
      ],
      external: ["sharp", "next"],
      outfile: path.join(outputPath, "index.mjs"),
    },
    options,
  );

  // Build Lambda code (2nd pass)
  // note: bundle in user's Next.js app again b/c the adapter relies on the
  //       "next" package. And the "next" package from user's app should
  //       be used.
  esbuildSync(
    {
      entryPoints: [path.join(outputPath, "index.mjs")],
      external: ["sharp"],
      allowOverwrite: true,
      outfile: path.join(outputPath, "index.mjs"),
      banner: {
        js: [
          "import { createRequire as topLevelCreateRequire } from 'module';",
          "const require = topLevelCreateRequire(import.meta.url);",
          "import bannerUrl from 'url';",
          "const __dirname = bannerUrl.fileURLToPath(new URL('.', import.meta.url));",
        ].join("\n"),
      },
    },
    options,
  );

  // Copy over .next/required-server-files.json file
  fs.mkdirSync(path.join(outputPath, ".next"));
  fs.copyFileSync(
    path.join(appBuildOutputPath, ".next/required-server-files.json"),
    path.join(outputPath, ".next/required-server-files.json"),
  );

  // Sharp provides pre-build binaries for all platforms. https://github.com/lovell/sharp/blob/main/docs/install.md#cross-platform
  // Target should be same as used by Lambda, see https://github.com/sst/sst/blob/ca6f763fdfddd099ce2260202d0ce48c72e211ea/packages/sst/src/constructs/NextjsSite.ts#L114
  // For SHARP_IGNORE_GLOBAL_LIBVIPS see: https://github.com/lovell/sharp/blob/main/docs/install.md#aws-lambda

  const nodeOutputPath = path.resolve(outputPath);
  const sharpVersion = process.env.SHARP_VERSION ?? "0.32.5";

  //check if we are running in Windows environment then set env variables accordingly.
  try {
    cp.execSync(
      `npm install --arch=arm64 --platform=linux --target=18 --libc=glibc --prefix="${nodeOutputPath}" sharp@${sharpVersion}`,
      {
        stdio: "pipe",
        cwd: appPath,
        env: {
          ...process.env,
          SHARP_IGNORE_GLOBAL_LIBVIPS: "1",
        },
      },
    );
  } catch (e: any) {
    logger.error(e.stdout.toString());
    logger.error(e.stderr.toString());
    logger.error("Failed to install sharp.");
  }
}

function createStaticAssets() {
  logger.info(`Bundling static assets...`);

  const { appBuildOutputPath, appPublicPath, outputDir, appPath } = options;

  // Create output folder
  const outputPath = path.join(outputDir, "assets");
  fs.mkdirSync(outputPath, { recursive: true });

  // Next.js outputs assets into multiple files. Copy into the same directory.
  // Copy over:
  // - .next/BUILD_ID => _next/BUILD_ID
  // - .next/static   => _next/static
  // - public/*       => *
  // - app/favicon.ico or src/app/favicon.ico  => favicon.ico
  fs.copyFileSync(
    path.join(appBuildOutputPath, ".next/BUILD_ID"),
    path.join(outputPath, "BUILD_ID"),
  );
  fs.cpSync(
    path.join(appBuildOutputPath, ".next/static"),
    path.join(outputPath, "_next", "static"),
    { recursive: true },
  );
  if (fs.existsSync(appPublicPath)) {
    fs.cpSync(appPublicPath, outputPath, { recursive: true });
  }

  const appSrcPath = fs.existsSync(path.join(appPath, "src"))
    ? "src/app"
    : "app";

  const faviconPath = path.join(appPath, appSrcPath, "favicon.ico");

  if (fs.existsSync(faviconPath)) {
    fs.copyFileSync(faviconPath, path.join(outputPath, "favicon.ico"));
  }
}

async function createCacheAssets(
  monorepoRoot: string,
  disableDynamoDBCache = false,
) {
  logger.info(`Bundling cache assets...`);

  const { appBuildOutputPath, outputDir } = options;
  const packagePath = path.relative(monorepoRoot, appBuildOutputPath);
  const buildId = getBuildId(appBuildOutputPath);

  // Copy pages to cache folder
  const dotNextPath = path.join(
    appBuildOutputPath,
    ".next/standalone",
    packagePath,
  );
  const outputPath = path.join(outputDir, "cache", buildId);
  [".next/server/pages", ".next/server/app"]
    .map((dir) => path.join(dotNextPath, dir))
    .filter(fs.existsSync)
    .forEach((dir) => fs.cpSync(dir, outputPath, { recursive: true }));

  // Remove non-cache files
  const htmlPages = getHtmlPages(dotNextPath);
  removeFiles(
    outputPath,
    (file) =>
      file.endsWith(".js") ||
      file.endsWith(".js.nft.json") ||
      (file.endsWith(".html") && htmlPages.has(file)),
  );

  //merge cache files into a single file
  const cacheFilesPath: Record<
    string,
    {
      meta?: string;
      html?: string;
      json?: string;
      rsc?: string;
      body?: string;
    }
  > = {};

  traverseFiles(
    outputPath,
    () => true,
    (filepath) => {
      const ext = path.extname(filepath);
      const newFilePath =
        ext !== "" ? filepath.replace(ext, ".cache") : `${filepath}.cache`;
      switch (ext) {
        case ".meta":
        case ".html":
        case ".json":
        case ".body":
        case ".rsc":
          cacheFilesPath[newFilePath] = {
            [ext.slice(1)]: filepath,
            ...cacheFilesPath[newFilePath],
          };
          break;
        case ".map":
          break;
        default:
          logger.warn(`Unknown file extension: ${ext}`);
          break;
      }
    },
  );

  // Generate cache file
  Object.entries(cacheFilesPath).forEach(([cacheFilePath, files]) => {
    const cacheFileContent = {
      type: files.body ? "route" : files.json ? "page" : "app",
      meta: files.meta
        ? JSON.parse(fs.readFileSync(files.meta, "utf8"))
        : undefined,
      html: files.html ? fs.readFileSync(files.html, "utf8") : undefined,
      json: files.json
        ? JSON.parse(fs.readFileSync(files.json, "utf8"))
        : undefined,
      rsc: files.rsc ? fs.readFileSync(files.rsc, "utf8") : undefined,
      body: files.body ? fs.readFileSync(files.body, "utf8") : undefined,
    };
    fs.writeFileSync(cacheFilePath, JSON.stringify(cacheFileContent));
  });

  if (!disableDynamoDBCache) {
    // Generate dynamodb data
    // We need to traverse the cache to find every .meta file
    const metaFiles: {
      tag: { S: string };
      path: { S: string };
      revalidatedAt: { N: string };
    }[] = [];

    // Compute dynamodb cache data
    // Traverse files inside cache to find all meta files and cache tags associated with them
    traverseFiles(
      outputPath,
      (file) => file.endsWith(".meta"),
      (filePath) => {
        const fileContent = fs.readFileSync(filePath, "utf8");
        const fileData = JSON.parse(fileContent);
        if (fileData.headers?.["x-next-cache-tags"]) {
          fileData.headers["x-next-cache-tags"]
            .split(",")
            .forEach((tag: string) => {
              // TODO: We should split the tag using getDerivedTags from next.js or maybe use an in house implementation
              metaFiles.push({
                tag: { S: path.posix.join(buildId, tag.trim()) },
                path: {
                  S: path.posix.join(
                    buildId,
                    path.relative(outputPath, filePath).replace(".meta", ""),
                  ),
                },
                revalidatedAt: { N: `${Date.now()}` },
              });
            });
        }
      },
    );

    // Copy fetch-cache to cache folder
    const fetchCachePath = path.join(
      appBuildOutputPath,
      ".next/cache/fetch-cache",
    );
    if (fs.existsSync(fetchCachePath)) {
      const fetchOutputPath = path.join(outputDir, "cache", "__fetch", buildId);
      fs.mkdirSync(fetchOutputPath, { recursive: true });
      fs.cpSync(fetchCachePath, fetchOutputPath, { recursive: true });

      traverseFiles(
        fetchCachePath,
        () => true,
        (filepath) => {
          const fileContent = fs.readFileSync(filepath, "utf8");
          const fileData = JSON.parse(fileContent);
          fileData?.tags?.forEach((tag: string) => {
            metaFiles.push({
              tag: { S: path.posix.join(buildId, tag) },
              path: {
                S: path.posix.join(
                  buildId,
                  path.relative(fetchCachePath, filepath),
                ),
              },
              revalidatedAt: { N: `${Date.now()}` },
            });
          });
        },
      );
    }

    if (metaFiles.length > 0) {
      const providerPath = path.join(outputDir, "dynamodb-provider");

      await esbuildAsync(
        {
          external: ["@aws-sdk/client-dynamodb"],
          entryPoints: [path.join(__dirname, "adapters", "dynamo-provider.js")],
          outfile: path.join(providerPath, "index.mjs"),
          target: ["node18"],
          plugins: [
            openNextResolvePlugin({
              overrides: {
                converter: "dummy",
              },
            }),
          ],
        },
        options,
      );

      //Copy open-next.config.js into the bundle
      fs.copyFileSync(
        path.join(options.tempDir, "open-next.config.js"),
        path.join(providerPath, "open-next.config.js"),
      );

      // TODO: check if metafiles doesn't contain duplicates
      fs.writeFileSync(
        path.join(providerPath, "dynamodb-cache.json"),
        JSON.stringify(metaFiles),
      );
    }
  }

  // We need to remove files later because we need the metafiles for dynamodb tags cache
  removeFiles(outputPath, (file) => !file.endsWith(".cache"));
}

/***************************/
/* Server Helper Functions */
/***************************/

function compileCache(options: Options) {
  const outfile = path.join(options.outputDir, ".build", "cache.cjs");
  const dangerousOptions = options.dangerous;
  esbuildSync(
    {
      external: ["next", "styled-jsx", "react", "@aws-sdk/*"],
      entryPoints: [path.join(__dirname, "adapters", "cache.js")],
      outfile,
      target: ["node18"],
      format: "cjs",
      banner: {
        js: [
          `globalThis.disableIncrementalCache = ${
            dangerousOptions?.disableIncrementalCache ?? false
          };`,
          `globalThis.disableDynamoDBCache = ${
            dangerousOptions?.disableDynamoDBCache ?? false
          };`,
        ].join(""),
      },
    },
    options,
  );
  return outfile;
}

async function createMiddleware() {
  console.info(`Bundling middleware function...`);

  const { appBuildOutputPath, outputDir, externalMiddleware } = options;

  // Get middleware manifest
  const middlewareManifest = JSON.parse(
    readFileSync(
      path.join(appBuildOutputPath, ".next/server/middleware-manifest.json"),
      "utf8",
    ),
  ) as MiddlewareManifest;

  const entry = middlewareManifest.middleware["/"];
  if (!entry) {
    return;
  }

  // Create output folder
  let outputPath = path.join(outputDir, "server-function");

  const commonMiddlewareOptions = {
    files: entry.files,
    routes: [
      {
        name: entry.name || "/",
        page: entry.page,
        regex: entry.matchers.map((m) => m.regexp),
      },
    ],
    options,
    appBuildOutputPath,
  };

  if (externalMiddleware) {
    outputPath = path.join(outputDir, "middleware");
    fs.mkdirSync(outputPath, { recursive: true });

    // Copy open-next.config.js
    fs.copyFileSync(
      path.join(options.tempDir, "open-next.config.js"),
      path.join(outputPath, "open-next.config.js"),
    );

    // Bundle middleware
    await buildEdgeBundle({
      entrypoint: path.join(__dirname, "adapters", "middleware.js"),
      outfile: path.join(outputPath, "handler.mjs"),
      ...commonMiddlewareOptions,
      defaultConverter: "aws-cloudfront",
    });
  } else {
    await buildEdgeBundle({
      entrypoint: path.join(__dirname, "core", "edgeFunctionHandler.js"),
      outfile: path.join(outputDir, ".build", "middleware.mjs"),
      ...commonMiddlewareOptions,
    });
  }
}

//TODO: Why do we need this? People have access to the headers in the middleware
function injectMiddlewareGeolocation(outputPath: string, packagePath: string) {
  // WORKAROUND: Set `NextRequest` geolocation data — https://github.com/serverless-stack/open-next#workaround-set-nextrequest-geolocation-data

  const basePath = path.join(outputPath, packagePath, ".next", "server");
  const rootMiddlewarePath = path.join(basePath, "middleware.js");
  const srcMiddlewarePath = path.join(basePath, "src", "middleware.js");
  if (fs.existsSync(rootMiddlewarePath)) {
    inject(rootMiddlewarePath);
  } else if (fs.existsSync(srcMiddlewarePath)) {
    inject(srcMiddlewarePath);
  }

  function inject(middlewarePath: string) {
    const content = fs.readFileSync(middlewarePath, "utf-8");
    fs.writeFileSync(
      middlewarePath,
      content.replace(
        "geo: init.geo || {}",
        `geo: init.geo || {
        country: this.headers.get("cloudfront-viewer-country"),
        countryName: this.headers.get("cloudfront-viewer-country-name"),
        region: this.headers.get("cloudfront-viewer-country-region"),
        regionName: this.headers.get("cloudfront-viewer-country-region-name"),
        city: this.headers.get("cloudfront-viewer-city"),
        postalCode: this.headers.get("cloudfront-viewer-postal-code"),
        timeZone: this.headers.get("cloudfront-viewer-time-zone"),
        latitude: this.headers.get("cloudfront-viewer-latitude"),
        longitude: this.headers.get("cloudfront-viewer-longitude"),
        metroCode: this.headers.get("cloudfront-viewer-metro-code"),
      }`,
      ),
    );
  }
}
