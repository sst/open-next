// NOTE: add more next config typings as they become relevant

import { InternalEvent } from "./event-mapper.js";
import { IncomingMessage } from "./request.js";
import { ServerResponse } from "./response.js";

type RemotePattern = {
  protocol?: "http" | "https";
  hostname: string;
  port?: string;
  pathname?: string;
};
declare type ImageFormat = "image/avif" | "image/webp";

type ImageConfigComplete = {
  deviceSizes: number[];
  imageSizes: number[];
  path: string;
  loaderFile: string;
  domains: string[];
  disableStaticImages: boolean;
  minimumCacheTTL: number;
  formats: ImageFormat[];
  dangerouslyAllowSVG: boolean;
  contentSecurityPolicy: string;
  contentDispositionType: "inline" | "attachment";
  remotePatterns: RemotePattern[];
  unoptimized: boolean;
};
type ImageConfig = Partial<ImageConfigComplete>;

export type RouteHas =
  | {
      type: "header" | "query" | "cookie";
      key: string;
      value?: string;
    }
  | {
      type: "host";
      key?: undefined;
      value: string;
    };
export type Rewrite = {
  source: string;
  destination: string;
  basePath?: false;
  locale?: false;
  has?: RouteHas[];
  missing?: RouteHas[];
};
export type Header = {
  source: string;
  basePath?: false;
  locale?: false;
  headers: Array<{
    key: string;
    value: string;
  }>;
  has?: RouteHas[];
  missing?: RouteHas[];
};
export interface NextConfig {
  basePath?: string;
  trailingSlash?: string;
  i18n?: {
    locales: string[];
  };
  experimental: {
    serverActions?: boolean;
    appDir?: boolean;
  };
  images: ImageConfig;
}

export interface RouteDefinition {
  page: string;
  regex: string;
}

export interface RoutesManifest {
  dynamicRoutes: RouteDefinition[];
  staticRoutes: RouteDefinition[];
  headers?: Header[];
}

export interface MiddlewareManifest {
  sortedMiddleware: string[];
  middleware: {
    [key: string]: {
      files: string[];
      paths?: string[];
      name: string;
      page: string;
      matchers: {
        regexp: string;
        originalSource: string;
      }[];
      wasm: string[];
      assets: string[];
    };
  };
  functions: { [key: string]: any };
  version: number;
}

export type Options = {
  internalEvent: InternalEvent;
  buildId: string;
};
export interface PluginHandler {
  (
    req: IncomingMessage,
    res: ServerResponse,
    options: Options,
  ): Promise<ServerResponse | undefined>;
}
