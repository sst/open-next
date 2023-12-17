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
  var __storage__: Map<unknown, unknown>;
  var AsyncContext: any;
  //@ts-ignore
  var AsyncLocalStorage: any;
}

interface Route {
  name: string;
  page: string;
  regex: string;
}

export default async function edgeFunctionHandler(
  routes: Route[],
  request: RequestData,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const correspondingRoute = routes.find((route) =>
    new RegExp(route.regex).test(path),
  );

  if (!correspondingRoute) {
    throw new Error(`No route found for ${request.url}`);
  }

  const result = await self._ENTRIES[
    `middleware_${correspondingRoute.name}`
  ].default({
    page: correspondingRoute.page,
    request: {
      headers: request.headers,
      method: request.method,
      url: request.url,
      signal: request.signal,
      page: {
        name: correspondingRoute.name,
      },
    },
  });
  await result.waitUntil;
  const response = result.response;
  return response;
}

// const route = "/ssr/page";

// const toExport = {
//   async fetch(req: Request, env: any, context: any) {
//     const headers: Record<string, string> = {};
//     req.headers.forEach((value, key) => {
//       headers[key] = value;
//     });
//     const result = await self._ENTRIES[`middleware_app${route}`].default({
//       page: route,
//       request: {
//         headers: headers,
//         method: req.method,
//         url: req.url,
//         signal: req.signal,
//         page: {
//           name: route,
//         },
//       },
//     });
//     const response = result.response;
//     context.waitUntil(result.waitUntil);
//     return response;
//   },
// };

// export default toExport;
