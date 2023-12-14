import * as fs from "node:fs";
import path from "node:path";

import { BuildOptions, FunctionOptions } from "types/open-next";

import { getBuildId } from "./helper.js";

type BaseFunction = {
  handler: string;
  bundle: string;
};

type OpenNextFunctionOrigin = {
  type: "function";
  streaming?: boolean;
} & BaseFunction;

type OpenNextECSOrigin = {
  type: "ecs";
  bundle: string;
  dockerfile: string;
};

type OpenNextS3Origin = {
  type: "s3";
  originPath: string;
  copy: {
    from: string;
    to: string;
    cached: boolean;
    versionedSubDir?: string;
  }[];
};

type OpenNextOrigins =
  | OpenNextFunctionOrigin
  | OpenNextECSOrigin
  | OpenNextS3Origin;

interface OpenNextOutput {
  edgeFunctions: {
    [key: string]: BaseFunction;
  };
  origins: {
    s3: OpenNextS3Origin;
    default: OpenNextFunctionOrigin | OpenNextECSOrigin;
    imageOptimizer: OpenNextFunctionOrigin | OpenNextECSOrigin;
    [key: string]: OpenNextOrigins;
  };
  behaviors: {
    pattern: string;
    origin?: string;
    edgeFunction?: string;
  }[];
  additionalProps?: {
    disableIncrementalCache?: boolean;
    disableTagCache?: boolean;
    initializationFunction?: BaseFunction;
    warmer?: BaseFunction;
    revalidationFunction?: BaseFunction;
  };
}

async function canStream(opts: FunctionOptions) {
  if (!opts.override?.wrapper) {
    return false;
  } else {
    if (typeof opts.override.wrapper === "string") {
      return opts.override.wrapper === "aws-lambda-streaming";
    } else {
      const wrapper = await opts.override.wrapper();
      return wrapper.supportStreaming;
    }
  }
}

export async function generateOutput(
  outputPath: string,
  buildOptions: BuildOptions,
) {
  const edgeFunctions: OpenNextOutput["edgeFunctions"] = {};
  const isExternalMiddleware = buildOptions.middleware?.external ?? false;
  if (isExternalMiddleware) {
    edgeFunctions.middleware = {
      bundle: ".open-next/middleware",
      handler: "handler.handler",
    };
  }
  // Add edge functions
  Object.entries(buildOptions.functions).forEach(([key, value]) => {
    if (value.placement === "global") {
      edgeFunctions[key] = {
        bundle: `.open-next/functions/${key}`,
        handler: "index.handler",
      };
    }
  });

  const defaultOriginCanstream = await canStream(buildOptions.default);

  // First add s3 origins and image optimization
  const origins: OpenNextOutput["origins"] = {
    s3: {
      type: "s3",
      originPath: "_assets",
      copy: [
        {
          from: ".open-next/assets",
          to: "_assets",
          cached: true,
          versionedSubDir: "_next",
        },
        ...(buildOptions.dangerous?.disableIncrementalCache
          ? []
          : [
              {
                from: ".open-next/cache",
                to: "cache",
                cached: false,
              },
            ]),
      ],
    },
    imageOptimizer: {
      type: "function",
      handler: "index.handler",
      bundle: ".open-next/image-optimization-function",
      streaming: false,
    },
    default: buildOptions.default.override?.generateDockerfile
      ? {
          type: "ecs",
          bundle: ".open-next/server-functions/default",
          dockerfile: ".open-next/server-functions/default/Dockerfile",
        }
      : {
          type: "function",
          handler: "index.handler",
          bundle: ".open-next/server-functions/default",
          streaming: defaultOriginCanstream,
        },
  };

  // Then add function origins
  await Promise.all(
    Object.entries(buildOptions.functions).map(async ([key, value]) => {
      if (!value.placement || value.placement === "regional") {
        if (value.override?.generateDockerfile) {
          origins[key] = {
            type: "ecs",
            bundle: `.open-next/server-functions/${key}`,
            dockerfile: `.open-next/server-functions/${key}/Dockerfile`,
          };
        } else {
          const streaming = await canStream(value);
          origins[key] = {
            type: "function",
            handler: "index.handler",
            bundle: `.open-next/server-functions/${key}`,
            streaming,
          };
        }
      }
    }),
  );

  // Then we need to compute the behaviors
  const behaviors: OpenNextOutput["behaviors"] = [
    { pattern: "_next/image*", origin: "imageOptimizer" },
  ];

  // Then we add the routes
  Object.entries(buildOptions.functions).forEach(([key, value]) => {
    const patterns = "patterns" in value ? value.patterns : ["*"];
    patterns.forEach((pattern) => {
      behaviors.push({
        pattern: pattern.replace(/BUILD_ID/, getBuildId(outputPath)),
        origin: value.placement === "global" ? undefined : key,
        edgeFunction:
          value.placement === "global"
            ? key
            : isExternalMiddleware
            ? "middleware"
            : undefined,
      });
    });
  });

  // We finish with the default behavior so that they don't override the others
  behaviors.push({
    pattern: "_next/data/*",
    origin: "default",
    edgeFunction: isExternalMiddleware ? "middleware" : undefined,
  });
  behaviors.push({
    pattern: "*",
    origin: "default",
    edgeFunction: isExternalMiddleware ? "middleware" : undefined,
  });

  //Compute behaviors for assets files
  const assetPath = path.join(outputPath, ".open-next", "assets");
  fs.readdirSync(assetPath).forEach((item) => {
    if (fs.statSync(path.join(assetPath, item)).isDirectory()) {
      behaviors.push({
        pattern: `${item}/*`,
        origin: "s3",
      });
    } else {
      behaviors.push({
        pattern: item,
        origin: "s3",
      });
    }
  });

  const output: OpenNextOutput = {
    edgeFunctions,
    origins,
    behaviors,
    additionalProps: {
      disableIncrementalCache: buildOptions.dangerous?.disableIncrementalCache,
      disableTagCache: buildOptions.dangerous?.disableDynamoDBCache,
      warmer: {
        handler: "index.handler",
        bundle: ".open-next/warmer-function",
      },
      initializationFunction: buildOptions.dangerous?.disableDynamoDBCache
        ? undefined
        : {
            handler: "index.handler",
            bundle: ".open-next/initialization-function",
          },
      revalidationFunction: buildOptions.dangerous?.disableIncrementalCache
        ? undefined
        : {
            handler: "index.handler",
            bundle: ".open-next/revalidation-function",
          },
    },
  };
  fs.writeFileSync(
    path.join(outputPath, ".open-next", "open-next.output.json"),
    JSON.stringify(output),
  );
}
