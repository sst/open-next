import cp from "node:child_process";
import fs, { readFileSync } from "node:fs";
import { createRequire as topLevelCreateRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import url from "node:url";

import { MiddlewareManifest } from "types/next-types.js";

import { isBinaryContentType } from "./adapters/binary.js";
import {
  compileOpenNextConfigEdge,
  compileOpenNextConfigNode,
} from "./build/compileConfig.js";
import { createServerBundle } from "./build/createServerBundle.js";
import { buildEdgeBundle } from "./build/edge/createEdgeBundle.js";
import { generateOutput } from "./build/generateOutput.js";
import {
  BuildOptions,
  compareSemver,
  copyOpenNextConfig,
  esbuildAsync,
  esbuildSync,
  getBuildId,
  getHtmlPages,
  normalizeOptions,
  removeFiles,
  traverseFiles,
} from "./build/helper.js";
import { validateConfig } from "./build/validateConfig.js";
import logger from "./logger.js";
import { openNextReplacementPlugin } from "./plugins/replacement.js";
import { openNextResolvePlugin } from "./plugins/resolve.js";
import { OpenNextConfig } from "./types/open-next.js";

const require = topLevelCreateRequire(import.meta.url);
const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
let options: BuildOptions;
let config: OpenNextConfig;

export type PublicFiles = {
  files: string[];
};

export async function build(
  openNextConfigPath?: string,
  nodeExternals?: string,
) {
  showWindowsWarning();

  // Load open-next.config.ts
  const tempDir = initTempDir();
  let configPath = compileOpenNextConfigNode(
    tempDir,
    openNextConfigPath,
    nodeExternals,
  );
  // On Windows, we need to use file:// protocol to load the config file using import()
  if (process.platform === "win32") configPath = `file://${configPath}`;
  config = (await import(configPath)).default as OpenNextConfig;
  if (!config || !config.default) {
    logger.error(
      `config.default cannot be empty, it should be at least {}, see more info here: https://open-next.js.org/config#configuration-file`,
    );
    process.exit(1);
  }
  validateConfig(config);

  compileOpenNextConfigEdge(tempDir, config, openNextConfigPath);

  const { root: monorepoRoot, packager } = findMonorepoRoot(
    path.join(process.cwd(), config.appPath || "."),
  );

  // Initialize options
  options = normalizeOptions(config, monorepoRoot);
  logger.setLevel(options.debug ? "debug" : "info");

  // Pre-build validation
  checkRunningInsideNextjsApp();
  printNextjsVersion();
  printOpenNextVersion();

  // Build Next.js app
  printHeader("Building Next.js app");
  setStandaloneBuildMode(monorepoRoot);
  buildNextjsApp(packager);

  // Generate deployable bundle
  printHeader("Generating bundle");
  initOutputDir(tempDir);

  // Compile cache.ts
  compileCache();

  // Compile middleware
  await createMiddleware();

  createStaticAssets();
  await createCacheAssets(monorepoRoot);

  await createServerBundle(config, options);
  await createRevalidationBundle(config);
  await createImageOptimizationBundle(config);
  await createWarmerBundle(config);
  await generateOutput(options.appBuildOutputPath, config);
  logger.info("OpenNext build complete.");
}

function showWindowsWarning() {
  if (os.platform() !== "win32") return;

  logger.warn("OpenNext is not fully compatible with Windows.");
  logger.warn(
    "For optimal performance, it is recommended to use Windows Subsystem for Linux (WSL).",
  );
  logger.warn(
    "While OpenNext may function on Windows, it could encounter unpredictable failures during runtime.",
  );
}

function initTempDir() {
  const dir = path.join(process.cwd(), ".open-next");
  const tempDir = path.join(dir, ".build");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

function checkRunningInsideNextjsApp() {
  const { appPath } = options;
  const extension = ["js", "cjs", "mjs", "ts"].find((ext) =>
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
      { file: "bun.lockb", packager: "bun" as const },
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

function buildNextjsApp(packager: "npm" | "yarn" | "pnpm" | "bun") {
  const { appPackageJsonPath } = options;
  const command =
    config.buildCommand ??
    (["bun", "npm"].includes(packager)
      ? `${packager} run build`
      : `${packager} build`);
  cp.execSync(command, {
    stdio: "inherit",
    cwd: path.dirname(appPackageJsonPath),
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
  const { nextVersion } = options;
  logger.info(`Next.js version : ${nextVersion}`);
}

function printOpenNextVersion() {
  const { openNextVersion } = options;
  logger.info(`OpenNext v${openNextVersion}`);
}

function initOutputDir(tempDir: string) {
  // We need to get the build relative to the cwd to find the compiled config
  // This is needed for the case where the app is a single-version monorepo and the package.json is in the root of the monorepo
  // where the build is in the app directory, but the compiled config is in the root of the monorepo.
  const { outputDir, tempDir: lTempDir } = options;
  const openNextConfig = readFileSync(
    path.join(tempDir, "open-next.config.mjs"),
    "utf8",
  );
  let openNextConfigEdge: string | null = null;
  if (fs.existsSync(path.join(tempDir, "open-next.config.edge.mjs"))) {
    openNextConfigEdge = readFileSync(
      path.join(tempDir, "open-next.config.edge.mjs"),
      "utf8",
    );
  }
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(lTempDir, { recursive: true });
  fs.writeFileSync(path.join(lTempDir, "open-next.config.mjs"), openNextConfig);
  if (openNextConfigEdge) {
    fs.writeFileSync(
      path.join(lTempDir, "open-next.config.edge.mjs"),
      openNextConfigEdge,
    );
  }
}

async function createWarmerBundle(config: OpenNextConfig) {
  logger.info(`Bundling warmer function...`);

  const { outputDir } = options;

  // Create output folder
  const outputPath = path.join(outputDir, "warmer-function");
  fs.mkdirSync(outputPath, { recursive: true });

  // Copy open-next.config.mjs into the bundle
  copyOpenNextConfig(options.tempDir, outputPath);

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
            converter: config.warmer?.override?.converter ?? "dummy",
            wrapper: config.warmer?.override?.wrapper,
          },
          fnName: "warmer",
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

async function createRevalidationBundle(config: OpenNextConfig) {
  logger.info(`Bundling revalidation function...`);

  const { appBuildOutputPath, outputDir } = options;

  // Create output folder
  const outputPath = path.join(outputDir, "revalidation-function");
  fs.mkdirSync(outputPath, { recursive: true });

  //Copy open-next.config.mjs into the bundle
  copyOpenNextConfig(options.tempDir, outputPath);

  // Build Lambda code
  await esbuildAsync(
    {
      external: ["next", "styled-jsx", "react"],
      entryPoints: [path.join(__dirname, "adapters", "revalidate.js")],
      outfile: path.join(outputPath, "index.mjs"),
      plugins: [
        openNextResolvePlugin({
          fnName: "revalidate",
          overrides: {
            converter:
              config.revalidate?.override?.converter ?? "sqs-revalidate",
            wrapper: config.revalidate?.override?.wrapper,
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

async function createImageOptimizationBundle(config: OpenNextConfig) {
  logger.info(`Bundling image optimization function...`);

  const { appPath, appBuildOutputPath, outputDir } = options;

  // Create output folder
  const outputPath = path.join(outputDir, "image-optimization-function");
  fs.mkdirSync(outputPath, { recursive: true });

  // Copy open-next.config.mjs into the bundle
  copyOpenNextConfig(options.tempDir, outputPath);

  const plugins = [
    openNextResolvePlugin({
      fnName: "imageOptimization",
      overrides: {
        converter: config.imageOptimization?.override?.converter,
        wrapper: config.imageOptimization?.override?.wrapper,
        imageLoader: config.imageOptimization?.loader,
      },
    }),
  ];

  if (compareSemver(options.nextVersion, "14.1.1") >= 0) {
    plugins.push(
      openNextReplacementPlugin({
        name: "opennext-14.1.1-image-optimization",
        target:
          /plugins(\/|\\)image-optimization(\/|\\)image-optimization\.js/g,
        replacements: [
          require.resolve(
            "./adapters/plugins/image-optimization/image-optimization.replacement.js",
          ),
        ],
      }),
    );
  }

  // Build Lambda code (1st pass)
  // note: bundle in OpenNext package b/c the adapter relies on the
  //       "@aws-sdk/client-s3" package which is not a dependency in user's
  //       Next.js app.
  await esbuildAsync(
    {
      entryPoints: [
        path.join(__dirname, "adapters", "image-optimization-adapter.js"),
      ],
      external: ["sharp", "next"],
      outfile: path.join(outputPath, "index.mjs"),
      plugins,
    },
    options,
  );

  // Build Lambda code (2nd pass)
  // note: bundle in user's Next.js app again b/c the adapter relies on the
  //       "next" package. And the "next" package from user's app should
  //       be used. We also set @opentelemetry/api as external because it seems to be
  //       required by Next 15 even though it's not used.
  esbuildSync(
    {
      entryPoints: [path.join(outputPath, "index.mjs")],
      external: ["sharp", "@opentelemetry/api"],
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

  // Copy over .next/required-server-files.json file and BUILD_ID
  fs.mkdirSync(path.join(outputPath, ".next"));
  fs.copyFileSync(
    path.join(appBuildOutputPath, ".next/required-server-files.json"),
    path.join(outputPath, ".next/required-server-files.json"),
  );
  fs.copyFileSync(
    path.join(appBuildOutputPath, ".next/BUILD_ID"),
    path.join(outputPath, ".next/BUILD_ID"),
  );

  // Sharp provides pre-build binaries for all platforms. https://github.com/lovell/sharp/blob/main/docs/install.md#cross-platform
  // Target should be same as used by Lambda, see https://github.com/sst/sst/blob/ca6f763fdfddd099ce2260202d0ce48c72e211ea/packages/sst/src/constructs/NextjsSite.ts#L114
  // For SHARP_IGNORE_GLOBAL_LIBVIPS see: https://github.com/lovell/sharp/blob/main/docs/install.md#aws-lambda

  const nodeOutputPath = path.resolve(outputPath);
  const sharpVersion = process.env.SHARP_VERSION ?? "0.32.6";

  const arch = config.imageOptimization?.arch ?? "arm64";
  const nodeVersion = config.imageOptimization?.nodeVersion ?? "18";

  //check if we are running in Windows environment then set env variables accordingly.
  try {
    cp.execSync(
      // We might want to change the arch args to cpu args, it seems to be the documented way
      `npm install --arch=${arch} --platform=linux --target=${nodeVersion} --libc=glibc --prefix="${nodeOutputPath}" sharp@${sharpVersion}`,
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

async function createCacheAssets(monorepoRoot: string) {
  if (config.dangerous?.disableIncrementalCache) return;

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
      let newFilePath =
        ext !== "" ? filepath.replace(ext, ".cache") : `${filepath}.cache`;
      // Handle prefetch cache files for partial prerendering
      if (newFilePath.endsWith(".prefetch.cache")) {
        newFilePath = newFilePath.replace(".prefetch.cache", ".cache");
      }
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
    const cacheFileMeta = files.meta
      ? JSON.parse(fs.readFileSync(files.meta, "utf8"))
      : undefined;
    const cacheFileContent = {
      type: files.body ? "route" : files.json ? "page" : "app",
      meta: cacheFileMeta,
      html: files.html ? fs.readFileSync(files.html, "utf8") : undefined,
      json: files.json
        ? JSON.parse(fs.readFileSync(files.json, "utf8"))
        : undefined,
      rsc: files.rsc ? fs.readFileSync(files.rsc, "utf8") : undefined,
      body: files.body
        ? fs
            .readFileSync(files.body)
            .toString(
              isBinaryContentType(cacheFileMeta.headers["content-type"])
                ? "base64"
                : "utf8",
            )
        : undefined,
    };
    fs.writeFileSync(cacheFilePath, JSON.stringify(cacheFileContent));
  });

  if (!config.dangerous?.disableTagCache) {
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
                // We don't care about the revalidation time here, we just need to make sure it's there
                revalidatedAt: { N: "1" },
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
              revalidatedAt: { N: "1" },
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
              fnName: "initializationFunction",
              overrides: {
                converter:
                  config.initializationFunction?.override?.converter ?? "dummy",
                wrapper: config.initializationFunction?.override?.wrapper,
              },
            }),
          ],
        },
        options,
      );

      //Copy open-next.config.mjs into the bundle
      copyOpenNextConfig(options.tempDir, providerPath);

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

export function compileCache(format: "cjs" | "esm" = "cjs") {
  const ext = format === "cjs" ? "cjs" : "mjs";
  const outfile = path.join(options.outputDir, ".build", `cache.${ext}`);

  const isAfter15 = compareSemver(options.nextVersion, "15.0.0") >= 0;

  esbuildSync(
    {
      external: ["next", "styled-jsx", "react", "@aws-sdk/*"],
      entryPoints: [path.join(__dirname, "adapters", "cache.js")],
      outfile,
      target: ["node18"],
      format,
      banner: {
        js: [
          `globalThis.disableIncrementalCache = ${
            config.dangerous?.disableIncrementalCache ?? false
          };`,
          `globalThis.disableDynamoDBCache = ${
            config.dangerous?.disableTagCache ?? false
          };`,
          `globalThis.isNextAfter15 = ${isAfter15};`,
        ].join(""),
      },
    },
    options,
  );
  return outfile;
}

async function createMiddleware() {
  console.info(`Bundling middleware function...`);

  const { appBuildOutputPath, outputDir } = options;

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
    middlewareInfo: entry,
    options,
    appBuildOutputPath,
  };

  if (config.middleware?.external) {
    outputPath = path.join(outputDir, "middleware");
    fs.mkdirSync(outputPath, { recursive: true });

    // Copy open-next.config.mjs
    copyOpenNextConfig(
      options.tempDir,
      outputPath,
      config.middleware.override?.wrapper === "cloudflare",
    );

    // Bundle middleware
    await buildEdgeBundle({
      entrypoint: path.join(__dirname, "adapters", "middleware.js"),
      outfile: path.join(outputPath, "handler.mjs"),
      ...commonMiddlewareOptions,
      overrides: config.middleware?.override,
      defaultConverter: "aws-cloudfront",
      includeCache: config.dangerous?.enableCacheInterception,
      additionalExternals: config.edgeExternals,
    });
  } else {
    await buildEdgeBundle({
      entrypoint: path.join(__dirname, "core", "edgeFunctionHandler.js"),
      outfile: path.join(outputDir, ".build", "middleware.mjs"),
      ...commonMiddlewareOptions,
      onlyBuildOnce: true,
    });
  }
}
