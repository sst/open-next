import { existsSync } from "node:fs";
import { createRequire as topLevelCreateRequire } from "node:module";

import fs from "fs";
import path from "path";
import { BuildOptions, FunctionOptions } from "types/open-next";
import url from "url";

import logger from "../logger.js";
import { openNextReplacementPlugin } from "../plugins/replacement.js";
import { openNextResolvePlugin } from "../plugins/resolve.js";
import { bundleNextServer } from "./bundleNextServer.js";
import { copyTracedFiles } from "./copyTracedFiles.js";
import { generateEdgeBundle } from "./edge/createEdgeBundle.js";
import type { Options } from "./helper.js";
import { compareSemver, esbuildAsync, traverseFiles } from "./helper.js";

const require = topLevelCreateRequire(import.meta.url);
const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

export async function createServerBundle(
  options: BuildOptions,
  buildRuntimeOptions: Options,
) {
  const foundRoutes = new Set<string>();
  // Get all functions to build
  const defaultFn = options.default;
  const functions = Object.entries(options.functions);

  const promises = functions.map(async ([name, fnOptions]) => {
    const routes = fnOptions.routes;
    routes.forEach((route) => foundRoutes.add(route));
    if (fnOptions.runtime === "edge") {
      await generateEdgeBundle(name, buildRuntimeOptions, fnOptions);
    } else {
      await generateBundle(name, buildRuntimeOptions, fnOptions);
    }
  });

  //TODO: throw an error if not all edge runtime routes has been bundled in a separate function

  // We build every other function than default before so we know which route there is left
  await Promise.all(promises);

  const remainingRoutes = new Set<string>();

  const { monorepoRoot, appBuildOutputPath } = buildRuntimeOptions;

  const packagePath = path.relative(monorepoRoot, appBuildOutputPath);

  // Find remaining routes
  const serverPath = path.join(
    buildRuntimeOptions.appBuildOutputPath,
    ".next",
    "standalone",
    packagePath,
    ".next",
    "server",
  );

  // Find app dir routes
  if (existsSync(path.join(serverPath, "app"))) {
    const appPath = path.join(serverPath, "app");
    traverseFiles(
      appPath,
      (file) => {
        if (file.endsWith("page.js") || file.endsWith("route.js")) {
          const route = `app/${file.replace(/\.js$/, "")}`;
          if (!foundRoutes.has(route)) {
            remainingRoutes.add(route);
          }
        }
        return false;
      },
      () => {},
    );
  }

  // Find pages dir routes
  if (existsSync(path.join(serverPath, "pages"))) {
    const pagePath = path.join(serverPath, "pages");
    traverseFiles(
      pagePath,
      (file) => {
        if (file.endsWith(".js")) {
          const route = `pages/${file.replace(/\.js$/, "")}`;
          if (!foundRoutes.has(route)) {
            remainingRoutes.add(route);
          }
        }
        return false;
      },
      () => {},
    );
  }

  // Generate default function
  await generateBundle("default", buildRuntimeOptions, {
    ...defaultFn,
    routes: Array.from(remainingRoutes),
    patterns: ["*"],
  });
}

async function generateBundle(
  name: string,
  options: Options,
  fnOptions: BuildOptions["functions"][string],
) {
  const { appPath, appBuildOutputPath, outputDir, monorepoRoot } = options;

  // Create output folder
  const outputPath = path.join(outputDir, "server-functions", name);
  fs.mkdirSync(outputPath, { recursive: true });

  // Resolve path to the Next.js app if inside the monorepo
  // note: if user's app is inside a monorepo, standalone mode places
  //       `node_modules` inside `.next/standalone`, and others inside
  //       `.next/standalone/package/path` (ie. `.next`, `server.js`).
  //       We need to output the handler file inside the package path.
  const isMonorepo = monorepoRoot !== appPath;
  const packagePath = path.relative(monorepoRoot, appBuildOutputPath);

  // Copy cache file
  // It needs to be inside ".next"
  fs.mkdirSync(path.join(outputPath, packagePath, ".next"), {
    recursive: true,
  });
  fs.copyFileSync(
    path.join(outputDir, ".build", "cache.cjs"),
    path.join(outputPath, packagePath, ".next", "cache.cjs"),
  );

  // Bundle next server if necessary
  const isBundled = fnOptions.experimentalBundledNextServer ?? false;
  if (isBundled) {
    bundleNextServer(path.join(outputPath, packagePath), appPath);
  }

  // // Copy middleware
  if (
    !options.externalMiddleware &&
    existsSync(path.join(outputDir, ".build", "middleware.mjs"))
  ) {
    fs.copyFileSync(
      path.join(outputDir, ".build", "middleware.mjs"),
      path.join(outputPath, packagePath, "middleware.mjs"),
    );
  }

  // Copy open-next.config.js
  fs.copyFileSync(
    path.join(outputDir, ".build", "open-next.config.js"),
    path.join(outputPath, packagePath, "open-next.config.js"),
  );
  // Copy all necessary traced files
  copyTracedFiles(
    appBuildOutputPath,
    packagePath,
    outputPath,
    fnOptions.routes ?? ["app/page.tsx"],
    isBundled,
  );

  // Build Lambda code
  // note: bundle in OpenNext package b/c the adapter relies on the
  //       "serverless-http" package which is not a dependency in user's
  //       Next.js app.

  const disableNextPrebundledReact =
    compareSemver(options.nextVersion, "13.5.1") >= 0 ||
    compareSemver(options.nextVersion, "13.4.1") <= 0;

  const overrides = fnOptions.override ?? {};

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
              "../adapters/plugins/without-routing/requestHandler.js",
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
  await esbuildAsync(
    {
      entryPoints: [path.join(__dirname, "../adapters", "server-adapter.js")],
      external: ["next", "./middleware.mjs", "./next-server.runtime.prod.js"],
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
      alias: {
        "next/dist/server/next-server.js": isBundled
          ? "./next-server.runtime.prod.js"
          : "next/dist/server/next-server.js",
      },
    },
    options,
  );

  if (isMonorepo) {
    addMonorepoEntrypoint(outputPath, packagePath);
  }

  const shouldGenerateDocker = shouldGenerateDockerfile(fnOptions);
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

function shouldGenerateDockerfile(options: FunctionOptions) {
  return options.override?.generateDockerfile ?? false;
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
