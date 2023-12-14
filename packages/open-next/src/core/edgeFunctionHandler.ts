// Necessary files will be imported here with banner in esbuild

import type { OutgoingHttpHeaders } from "http";

interface RequestData {
  geo?: {
    city?: string;
    country?: string;
    region?: string;
    latitude?: string;
    longitude?: string;
  };
  headers: OutgoingHttpHeaders;
  ip?: string;
  method: string;
  nextConfig?: {
    basePath?: string;
    i18n?: any;
    trailingSlash?: boolean;
  };
  page?: {
    name?: string;
    params?: { [key: string]: string | string[] };
  };
  url: string;
  body?: ReadableStream<Uint8Array>;
  signal: AbortSignal;
}

interface Entries {
  [k: string]: {
    default: (props: { page: string; request: RequestData }) => Promise<{
      response: Response;
      waitUntil: Promise<void>;
    }>;
  };
}
declare global {
  var _ENTRIES: Entries;
  var _ROUTES: EdgeRoute[];
  var __storage__: Map<unknown, unknown>;
  var AsyncContext: any;
  //@ts-ignore
  var AsyncLocalStorage: any;
}

export interface EdgeRoute {
  name: string;
  page: string;
  regex: string[];
}

type EdgeRequest = Omit<RequestData, "page">;

export default async function edgeFunctionHandler(
  request: EdgeRequest,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const routes = globalThis._ROUTES;
  const correspondingRoute = routes.find((route) =>
    route.regex.some((r) => new RegExp(r).test(path)),
  );

  if (!correspondingRoute) {
    throw new Error(`No route found for ${request.url}`);
  }

  const result = await self._ENTRIES[
    `middleware_${correspondingRoute.name}`
  ].default({
    page: correspondingRoute.page,
    request: {
      ...request,
      page: {
        name: correspondingRoute.name,
      },
    },
  });
  await result.waitUntil;
  const response = result.response;
  return response;
}
