import fs from "fs";
import path from "path";
import {
  MiddlewareManifest,
  NextConfig,
  PrerenderManifest,
  RoutesManifest,
} from "types/next-types";

import { PublicFiles } from "../../build";

export function loadConfig(nextDir: string) {
  const filePath = path.join(nextDir, "required-server-files.json");
  const json = fs.readFileSync(filePath, "utf-8");
  const { config } = JSON.parse(json);
  return config as NextConfig;
}
export function loadBuildId(nextDir: string) {
  const filePath = path.join(nextDir, "BUILD_ID");
  return fs.readFileSync(filePath, "utf-8").trim();
}

export function loadHtmlPages(nextDir: string) {
  const filePath = path.join(nextDir, "server", "pages-manifest.json");
  const json = fs.readFileSync(filePath, "utf-8");
  return Object.entries(JSON.parse(json))
    .filter(([_, value]) => (value as string).endsWith(".html"))
    .map(([key]) => key);
}

export function loadPublicAssets(openNextDir: string) {
  const filePath = path.join(openNextDir, "public-files.json");
  const json = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(json) as PublicFiles;
}

export function loadRoutesManifest(nextDir: string) {
  const filePath = path.join(nextDir, "routes-manifest.json");
  const json = fs.readFileSync(filePath, "utf-8");
  const routesManifest = JSON.parse(json) as RoutesManifest;

  const _dataRoutes = routesManifest.dataRoutes ?? [];
  const dataRoutes = {
    static: _dataRoutes.filter((r) => r.routeKeys === undefined),
    dynamic: _dataRoutes.filter((r) => r.routeKeys !== undefined),
  };

  return {
    rewrites: Array.isArray(routesManifest.rewrites)
      ? { beforeFiles: [], afterFiles: routesManifest.rewrites, fallback: [] }
      : {
          beforeFiles: routesManifest.rewrites.beforeFiles ?? [],
          afterFiles: routesManifest.rewrites.afterFiles ?? [],
          fallback: routesManifest.rewrites.fallback ?? [],
        },
    redirects: routesManifest.redirects ?? [],
    routes: {
      static: routesManifest.staticRoutes ?? [],
      dynamic: routesManifest.dynamicRoutes ?? [],
      data: dataRoutes,
    },
  };
}

export function loadConfigHeaders(nextDir: string) {
  const filePath = path.join(nextDir, "routes-manifest.json");
  const json = fs.readFileSync(filePath, "utf-8");
  const routesManifest = JSON.parse(json) as RoutesManifest;
  return routesManifest.headers;
}

export function loadPrerenderManifest(nextDir: string) {
  const filePath = path.join(nextDir, "prerender-manifest.json");
  const json = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(json) as PrerenderManifest;
}

export function loadAppPathsManifestKeys(nextDir: string) {
  const appPathsManifestPath = path.join(
    nextDir,
    "server",
    "app-paths-manifest.json",
  );
  const appPathsManifestJson = fs.existsSync(appPathsManifestPath)
    ? fs.readFileSync(appPathsManifestPath, "utf-8")
    : "{}";
  const appPathsManifest = JSON.parse(appPathsManifestJson) as Record<
    string,
    string
  >;
  return Object.keys(appPathsManifest).map((key) => {
    // Remove parallel route
    let cleanedKey = key.replace(/\/@[^\/]+/g, "");

    // Remove group routes
    cleanedKey = cleanedKey.replace(/\/\((?!\.)[^\)]*\)/g, "");

    // Remove /page suffix
    cleanedKey = cleanedKey.replace(/\/page$/g, "");
    // We need to check if the cleaned key is empty because it means it's the root path
    return cleanedKey === "" ? "/" : cleanedKey;
  });
}

export function loadMiddlewareManifest(nextDir: string) {
  const filePath = path.join(nextDir, "server", "middleware-manifest.json");
  const json = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(json) as MiddlewareManifest;
}
