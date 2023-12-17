import cp from "node:child_process";
import fs, { readFileSync } from "node:fs";
import { createRequire as topLevelCreateRequire } from "node:module";
import path from "node:path";
import url from "node:url";

import {
  build as buildAsync,
  BuildOptions as ESBuildOptions,
  buildSync,
} from "esbuild";

import logger from "./logger.js";
import { minifyAll } from "./minimize-js.js";
import { openNextEdgePlugins } from "./plugins/edge.js";
import { openNextReplacementPlugin } from "./plugins/replacement.js";
import { openNextResolvePlugin } from "./plugins/resolve.js";
import { BuildOptions, DangerousOptions } from "./types/open-next.js";

const require = topLevelCreateRequire(import.meta.url);
const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
let options: ReturnType<typeof normalizeOptions>;

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
  createStaticAssets();
  if (!options.dangerous?.disableIncrementalCache) {
    await createCacheAssets(
      monorepoRoot,
      options.dangerous?.disableDynamoDBCache,
    );
  }
  await createServerBundle(monorepoRoot, opts);
  await createRevalidationBundle();
  createImageOptimizationBundle();
  await createWarmerBundle();
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

function normalizeOptions(opts: BuildOptions, root: string) {
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
      opts.functions.default.minify ??
      Boolean(process.env.OPEN_NEXT_MINIFY) ??
      false,
    debug:
      opts.functions.default.debug ??
      Boolean(process.env.OPEN_NEXT_DEBUG) ??
      false,
    buildCommand: opts.buildCommand,
    dangerous: opts.dangerous,
    externalMiddleware: opts.middleware?.external ?? false,
  };
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

function findNextPackageJsonPath(appPath: string, root: string) {
  // This is needed for the case where the app is a single-version monorepo and the package.json is in the root of the monorepo
  return fs.existsSync(path.join(appPath, "./package.json"))
    ? path.join(appPath, "./package.json")
    : path.join(root, "./package.json");
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
  await esbuildAsync({
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
  });
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
  esbuildAsync({
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
  });

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
  esbuildSync({
    entryPoints: [
      path.join(__dirname, "adapters", "image-optimization-adapter.js"),
    ],
    external: ["sharp", "next"],
    outfile: path.join(outputPath, "index.mjs"),
  });

  // Build Lambda code (2nd pass)
  // note: bundle in user's Next.js app again b/c the adapter relies on the
  //       "next" package. And the "next" package from user's app should
  //       be used.
  esbuildSync({
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
  });

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

      await esbuildAsync({
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
      });

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

function shouldGenerateDockerfile(
  options: BuildOptions["functions"]["default"],
) {
  return options.override?.generateDockerfile ?? false;
}

async function createServerBundle(
  monorepoRoot: string,
  buildOptions: BuildOptions,
) {
  logger.info(`Bundling server function...`);

  const { appPath, appBuildOutputPath, outputDir } = options;

  // Create output folder
  const outputPath = path.join(outputDir, "server-function");
  fs.mkdirSync(outputPath, { recursive: true });

  // Resolve path to the Next.js app if inside the monorepo
  // note: if user's app is inside a monorepo, standalone mode places
  //       `node_modules` inside `.next/standalone`, and others inside
  //       `.next/standalone/package/path` (ie. `.next`, `server.js`).
  //       We need to output the handler file inside the package path.
  const isMonorepo = monorepoRoot !== appPath;
  const packagePath = path.relative(monorepoRoot, appBuildOutputPath);

  // Copy open-next.config.js
  // We should reuse the one we created at the beginning of the build
  fs.mkdirSync(path.join(outputPath, packagePath), { recursive: true });
  fs.copyFileSync(
    path.join(options.tempDir, "open-next.config.js"),
    path.join(outputPath, packagePath, "open-next.config.js"),
  );

  // Bundle middleware
  createMiddleware(packagePath);

  // Copy over standalone output files
  // note: if user uses pnpm as the package manager, node_modules contain
  //       symlinks. We don't want to resolve the symlinks when copying.
  fs.cpSync(path.join(appBuildOutputPath, ".next/standalone"), outputPath, {
    recursive: true,
    verbatimSymlinks: true,
  });

  // Standalone output already has a Node server "server.js", remove it.
  // It will be replaced with the Lambda handler.
  fs.rmSync(path.join(outputPath, packagePath, "server.js"), { force: true });

  // Build Lambda code
  // note: bundle in OpenNext package b/c the adapter relies on the
  //       "serverless-http" package which is not a dependency in user's
  //       Next.js app.

  const disableNextPrebundledReact =
    compareSemver(options.nextVersion, "13.5.1") >= 0 ||
    compareSemver(options.nextVersion, "13.4.1") <= 0;

  const overrides = buildOptions.functions.default.override ?? {};

  const isBefore13413 = compareSemver(options.nextVersion, "13.4.13") <= 0;

  const disableRouting = isBefore13413 || options.externalMiddleware;
  const plugins = [
    openNextReplacementPlugin({
      name: "requestHandlerOverride",
      target: /core\/requestHandler.js/g,
      deletes: disableNextPrebundledReact ? ["applyNextjsPrebundledReact"] : [],
      replacements: disableRouting
        ? [
            require.resolve(
              "./adapters/plugins/without-routing/requestHandler.js",
            ),
          ]
        : [],
    }),
    openNextReplacementPlugin({
      name: "core/util",
      target: /core\/util.js/g,
      deletes: [
        ...(disableNextPrebundledReact ? ["requireHooks"] : []),
        ...(disableRouting ? ["trustHostHeader"] : []),
        ...(!isBefore13413 ? ["requestHandlerHost"] : []),
      ],
    }),

    openNextResolvePlugin({
      overrides: {
        converter:
          typeof overrides.converter === "function"
            ? "dummy"
            : overrides.converter,
        wrapper:
          typeof overrides.wrapper === "function"
            ? "aws-lambda"
            : overrides.wrapper,
      },
    }),
  ];

  if (plugins && plugins.length > 0) {
    logger.debug(
      `Applying plugins:: [${plugins
        .map(({ name }) => name)
        .join(",")}] for Next version: ${options.nextVersion}`,
    );
  }
  await esbuildAsync({
    entryPoints: [path.join(__dirname, "adapters", "server-adapter.js")],
    external: ["next", "./middleware.mjs"],
    outfile: path.join(outputPath, packagePath, "index.mjs"),
    banner: {
      js: [
        `globalThis.monorepoPackagePath = "${packagePath}";`,
        "import { createRequire as topLevelCreateRequire } from 'module';",
        "const require = topLevelCreateRequire(import.meta.url);",
        "import bannerUrl from 'url';",
        "const __dirname = bannerUrl.fileURLToPath(new URL('.', import.meta.url));",
      ].join(""),
    },
    plugins,
  });

  if (isMonorepo) {
    addMonorepoEntrypoint(outputPath, packagePath);
  }
  addPublicFilesList(outputPath, packagePath);
  injectMiddlewareGeolocation(outputPath, packagePath);
  removeCachedPages(outputPath, packagePath);
  addCacheHandler(
    path.join(outputPath, packagePath, ".next"),
    options.dangerous,
  );

  const shouldGenerateDocker = shouldGenerateDockerfile(
    buildOptions.functions.default,
  );
  if (shouldGenerateDocker) {
    fs.writeFileSync(
      path.join(outputPath, "Dockerfile"),
      typeof shouldGenerateDocker === "string"
        ? shouldGenerateDocker
        : `
FROM node:18-alpine
WORKDIR /app
COPY . /app
EXPOSE 3000
CMD ["node", "index.mjs"]
    `,
    );
  }
}

async function createMiddleware(packagePath: string) {
  console.info(`Bundling middleware function...`);

  const { appBuildOutputPath, outputDir, externalMiddleware } = options;

  // Get middleware manifest
  const middlewareManifest = JSON.parse(
    readFileSync(
      path.join(appBuildOutputPath, ".next/server/middleware-manifest.json"),
      "utf8",
    ),
  );

  const entry = middlewareManifest.middleware["/"];
  if (!entry) {
    return;
  }

  // Create output folder
  let outputPath = path.join(outputDir, "server-function");
  if (externalMiddleware) {
    outputPath = path.join(outputDir, "middleware");
    fs.mkdirSync(outputPath, { recursive: true });

    // Copy open-next.config.js
    fs.copyFileSync(
      path.join(options.tempDir, "open-next.config.js"),
      path.join(outputPath, "open-next.config.js"),
    );

    // Bundle middleware
    await esbuildAsync({
      entryPoints: [path.join(__dirname, "adapters", "middleware.js")],
      // inject: ,
      bundle: true,
      outfile: path.join(outputPath, packagePath, "handler.mjs"),
      external: ["node:*", "next", "@aws-sdk/*"],
      target: "es2022",
      platform: "neutral",
      plugins: [
        openNextResolvePlugin({
          overrides: {
            wrapper: "cloudflare",
            converter: "edge",
          },
        }),
        openNextEdgePlugins({
          entryFiles: entry.files.map((file: string) =>
            path.join(appBuildOutputPath, ".next", file),
          ),
          nextDir: path.join(appBuildOutputPath, ".next"),
          edgeFunctionHandlerPath: path.join(
            __dirname,
            "core",
            "edgeFunctionHandler.js",
          ),
        }),
      ],
      treeShaking: true,
      alias: {
        path: "node:path",
        stream: "node:stream",
      },
      conditions: ["module"],
      mainFields: ["module", "main"],
    });
  } else {
    buildEdgeFunction(
      entry,
      path.join(__dirname, "core", "edgeFunctionHandler.js"),
      path.join(outputPath, packagePath, "middleware.mjs"),
      appBuildOutputPath,
    );
  }
}

function buildEdgeFunction(
  entry: any,
  entrypoint: string,
  outfile: string,
  appBuildOutputPath: string,
) {
  esbuildSync({
    entryPoints: [entrypoint],
    inject: entry.files.map((file: string) =>
      path.join(appBuildOutputPath, ".next", file),
    ),
    bundle: true,
    outfile,
    external: ["node:*"],
    target: "es2022",
    platform: "neutral",
    banner: {
      js: `
globalThis._ENTRIES = {};
globalThis.self = globalThis;

import {Buffer} from "node:buffer";
globalThis.Buffer = Buffer;

import {AsyncLocalStorage} from "node:async_hooks";
globalThis.AsyncLocalStorage = AsyncLocalStorage;

`,
    },
  });
}

function addMonorepoEntrypoint(outputPath: string, packagePath: string) {
  // Note: in the monorepo case, the handler file is output to
  //       `.next/standalone/package/path/index.mjs`, but we want
  //       the Lambda function to be able to find the handler at
  //       the root of the bundle. We will create a dummy `index.mjs`
  //       that re-exports the real handler.

  // Always use posix path for import path
  const packagePosixPath = packagePath.split(path.sep).join(path.posix.sep);
  fs.writeFileSync(
    path.join(outputPath, "index.mjs"),
    [`export * from "./${packagePosixPath}/index.mjs";`].join(""),
  );
}

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

function addPublicFilesList(outputPath: string, packagePath: string) {
  // Get a list of all files in /public
  const { appPublicPath } = options;
  const acc: PublicFiles = { files: [] };

  function processDirectory(pathInPublic: string) {
    const files = fs.readdirSync(path.join(appPublicPath, pathInPublic), {
      withFileTypes: true,
    });

    for (const file of files) {
      file.isDirectory()
        ? processDirectory(path.join(pathInPublic, file.name))
        : acc.files.push(path.posix.join(pathInPublic, file.name));
    }
  }

  if (fs.existsSync(appPublicPath)) {
    processDirectory("/");
  }

  // Save the list
  const outputOpenNextPath = path.join(outputPath, packagePath, ".open-next");
  fs.mkdirSync(outputOpenNextPath, { recursive: true });
  fs.writeFileSync(
    path.join(outputOpenNextPath, "public-files.json"),
    JSON.stringify(acc),
  );
}

function removeCachedPages(outputPath: string, packagePath: string) {
  // Pre-rendered pages will be served out from S3 by the cache handler
  const dotNextPath = path.join(outputPath, packagePath);
  const isFallbackTruePage = /\[.*\]/;
  const htmlPages = getHtmlPages(dotNextPath);
  [".next/server/pages", ".next/server/app"]
    .map((dir) => path.join(dotNextPath, dir))
    .filter(fs.existsSync)
    .forEach((dir) =>
      removeFiles(
        dir,
        (file) =>
          file.endsWith(".json") ||
          file.endsWith(".rsc") ||
          file.endsWith(".meta") ||
          (file.endsWith(".html") &&
            // do not remove static HTML files
            !htmlPages.has(file) &&
            // do not remove HTML files with "[param].html" format
            // b/c they are used for "fallback:true" pages
            !isFallbackTruePage.test(file)),
      ),
    );
}

function addCacheHandler(outputPath: string, options?: DangerousOptions) {
  esbuildSync({
    external: ["next", "styled-jsx", "react"],
    entryPoints: [path.join(__dirname, "adapters", "cache.js")],
    outfile: path.join(outputPath, "cache.cjs"),
    target: ["node18"],
    format: "cjs",
    banner: {
      js: [
        `globalThis.disableIncrementalCache = ${
          options?.disableIncrementalCache ?? false
        };`,
        `globalThis.disableDynamoDBCache = ${
          options?.disableDynamoDBCache ?? false
        };`,
      ].join(""),
    },
  });
}

/********************/
/* Helper Functions */
/********************/

function esbuildSync(esbuildOptions: ESBuildOptions) {
  const { openNextVersion, debug } = options;
  const result = buildSync({
    target: "esnext",
    format: "esm",
    platform: "node",
    bundle: true,
    minify: debug ? false : true,
    sourcemap: debug ? "inline" : false,
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

async function esbuildAsync(esbuildOptions: ESBuildOptions) {
  const { openNextVersion, debug } = options;
  const result = await buildAsync({
    target: "esnext",
    format: "esm",
    platform: "node",
    bundle: true,
    minify: debug ? false : true,
    sourcemap: debug ? "inline" : false,
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

function removeFiles(
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

function traverseFiles(
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

function getHtmlPages(dotNextPath: string) {
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

function getBuildId(dotNextPath: string) {
  return fs
    .readFileSync(path.join(dotNextPath, ".next/BUILD_ID"), "utf-8")
    .trim();
}

function getOpenNextVersion() {
  return require(path.join(__dirname, "../package.json")).version;
}

function getNextVersion(nextPackageJsonPath: string) {
  const version = require(nextPackageJsonPath)?.dependencies?.next;
  // require('next/package.json').version

  if (!version) {
    throw new Error("Failed to find Next version");
  }

  // Drop the -canary.n suffix
  return version.split("-")[0];
}

function compareSemver(v1: string, v2: string): number {
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
