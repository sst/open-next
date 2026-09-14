import { AsyncLocalStorage } from "node:async_hooks";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { OpenNextNodeResponse } from "http/index.js";
import { IncomingMessage } from "http/index.js";
import type {
  InternalEvent,
  InternalResult,
  ResolvedRoute,
  RoutingResult,
} from "types/open-next";
import { ISR_HEADER } from "utils/cacheHeaders";
import { runWithOpenNextRequestContext } from "utils/promise";

import { NextConfig } from "config/index";
import type { OpenNextHandlerOptions } from "types/overrides";
import { debug, error } from "../adapters/logger";
import { patchAsyncStorage } from "./patchAsyncStorage";
import {
  constructNextUrl,
  convertRes,
  convertToQuery,
  convertToQueryString,
  createServerResponse,
} from "./routing/util";
import routingHandler, {
  INTERNAL_EVENT_REQUEST_ID,
  INTERNAL_HEADER_REWRITE_STATUS_CODE,
  INTERNAL_HEADER_INITIAL_URL,
  INTERNAL_HEADER_RESOLVED_ROUTES,
  MIDDLEWARE_HEADER_PREFIX,
  MIDDLEWARE_HEADER_PREFIX_LEN,
} from "./routingHandler";
import { requestHandler, setNextjsPrebundledReact } from "./util";

// This is used to identify requests in the cache
globalThis.__openNextAls = new AsyncLocalStorage();

//#override patchAsyncStorage
patchAsyncStorage();
//#endOverride

export async function openNextHandler(
  internalEvent: InternalEvent,
  options?: OpenNextHandlerOptions,
): Promise<InternalResult> {
  const initialHeaders = internalEvent.headers;
  // We only use the requestId header if we are using an external middleware
  // This is to ensure that no one can spoof the requestId
  // When using an external middleware, we always assume that headers cannot be spoofed
  const requestId = globalThis.openNextConfig.middleware?.external
    ? internalEvent.headers[INTERNAL_EVENT_REQUEST_ID]
    : Math.random().toString(36);
  // We run everything in the async local storage context so that it is available in the middleware as well as in NextServer
  return runWithOpenNextRequestContext(
    {
      isISRRevalidation: initialHeaders[ISR_HEADER] === "1",
      waitUntil: options?.waitUntil,
      requestId,
    },
    async () => {
      await globalThis.__next_route_preloader("waitUntil");
      if (initialHeaders["x-forwarded-host"]) {
        initialHeaders.host = initialHeaders["x-forwarded-host"];
      }
      debug("internalEvent", internalEvent);

      // These 3 will get overwritten by the routing handler if not using an external middleware
      const internalHeaders = {
        initialPath:
          initialHeaders[INTERNAL_HEADER_INITIAL_URL] ?? internalEvent.rawPath,
        resolvedRoutes: initialHeaders[INTERNAL_HEADER_RESOLVED_ROUTES]
          ? JSON.parse(initialHeaders[INTERNAL_HEADER_RESOLVED_ROUTES])
          : ([] as ResolvedRoute[]),
        rewriteStatusCode: Number.parseInt(
          initialHeaders[INTERNAL_HEADER_REWRITE_STATUS_CODE],
        ),
      };

      let routingResult: InternalResult | RoutingResult = {
        internalEvent,
        isExternalRewrite: false,
        origin: false,
        isISR: false,
        initialURL: internalEvent.url,
        ...internalHeaders,
      };

      //#override withRouting
      routingResult = await routingHandler(internalEvent, {
        assetResolver: globalThis.assetResolver,
      });
      //#endOverride

      const headers =
        "type" in routingResult
          ? routingResult.headers
          : routingResult.internalEvent.headers;

      const overwrittenResponseHeaders: Record<string, string | string[]> = {};

      for (const [rawKey, value] of Object.entries(headers)) {
        if (!rawKey.startsWith(MIDDLEWARE_HEADER_PREFIX)) {
          continue;
        }
        const key = rawKey.slice(MIDDLEWARE_HEADER_PREFIX_LEN);
        // We skip this header here since it is used by Next internally and we don't want it on the response headers.
        // This header needs to be present in the request headers for processRequest, so cookies().get() from Next will work on initial render.
        if (key !== "x-middleware-set-cookie") {
          overwrittenResponseHeaders[key] = value;
        }
        headers[key] = value;
        delete headers[rawKey];
      }

      if (
        "isExternalRewrite" in routingResult &&
        routingResult.isExternalRewrite === true
      ) {
        try {
          routingResult = await globalThis.proxyExternalRequest.proxy(
            routingResult.internalEvent,
          );
        } catch (e) {
          error("External request failed.", e);
          routingResult = {
            internalEvent: {
              type: "core",
              rawPath: "/500",
              method: "GET",
              headers: {},
              url: constructNextUrl(internalEvent.url, "/500"),
              query: {},
              cookies: {},
              remoteAddress: "",
            },
            // On error we need to rewrite to the 500 page which is an internal rewrite
            isExternalRewrite: false,
            isISR: false,
            origin: false,
            initialURL: internalEvent.url,
            resolvedRoutes: [{ route: "/500", type: "page" }],
          };
        }
      }

      if ("type" in routingResult) {
        // response is used only in the streaming case
        if (options?.streamCreator) {
          const response = createServerResponse(
            {
              internalEvent,
              isExternalRewrite: false,
              isISR: false,
              resolvedRoutes: [],
              origin: false,
              initialURL: internalEvent.url,
            },
            routingResult.headers,
            options.streamCreator,
          );
          response.statusCode = routingResult.statusCode;
          response.flushHeaders();
          const [bodyToConsume, bodyToReturn] = routingResult.body.tee();
          // Use pipeline so the streamCreator Writable can apply backpressure
          // instead of eagerly consuming the whole Web stream.
          await pipeline(Readable.fromWeb(bodyToConsume), response);
          routingResult.body = bodyToReturn;
        }
        return routingResult;
      }

      const preprocessedEvent = routingResult.internalEvent;
      debug("preprocessedEvent", preprocessedEvent);
      const { search, pathname, hash } = new URL(preprocessedEvent.url);
      const reqProps = {
        method: preprocessedEvent.method,
        url: `${pathname}${search}${hash}`,
        //WORKAROUND: We pass this header to the serverless function to mimic a prefetch request which will not trigger revalidation since we handle revalidation differently
        // There is 3 way we can handle revalidation:
        // 1. We could just let the revalidation go as normal, but due to race conditions the revalidation will be unreliable
        // 2. We could alter the lastModified time of our cache to make next believe that the cache is fresh, but this could cause issues with stale data since the cdn will cache the stale data as if it was fresh
        // 3. OUR CHOICE: We could pass a purpose prefetch header to the serverless function to make next believe that the request is a prefetch request and not trigger revalidation (This could potentially break in the future if next changes the behavior of prefetch requests)
        headers: {
          ...headers,
          //#override appendPrefetch
          purpose: "prefetch",
          //#endOverride
        },
        body: preprocessedEvent.body,
        remoteAddress: preprocessedEvent.remoteAddress,
      };

      const mergeHeadersPriority = globalThis.openNextConfig.dangerous
        ?.headersAndCookiesPriority
        ? globalThis.openNextConfig.dangerous.headersAndCookiesPriority(
            preprocessedEvent,
          )
        : "middleware";
      const store = globalThis.__openNextAls.getStore();
      if (store) {
        store.mergeHeadersPriority = mergeHeadersPriority;
      }

      const req = new IncomingMessage(reqProps);
      const res = createServerResponse(
        routingResult,
        overwrittenResponseHeaders,
        options?.streamCreator,
      );

      await processRequest(req, res, routingResult);

      const {
        statusCode,
        headers: responseHeaders,
        isBase64Encoded,
        body,
      } = convertRes(res);

      const internalResult = {
        type: internalEvent.type,
        statusCode,
        headers: responseHeaders,
        body,
        isBase64Encoded,
      };

      return internalResult;
    },
  );
}

async function processRequest(
  req: IncomingMessage,
  res: OpenNextNodeResponse,
  routingResult: RoutingResult,
) {
  // @ts-ignore
  // Next.js doesn't parse body if the property exists
  // https://github.com/dougmoscrop/serverless-http/issues/227
  delete req.body;

  // Here we try to apply as much request metadata as possible
  // We apply every metadata from `resolve-routes` https://github.com/vercel/next.js/blob/916f105b97211de50f8580f0b39c9e7c60de4886/packages/next/src/server/lib/router-utils/resolve-routes.ts
  // and `router-server` https://github.com/vercel/next.js/blob/916f105b97211de50f8580f0b39c9e7c60de4886/packages/next/src/server/lib/router-server.ts
  const initialURL = new URL(
    // We always assume that only the routing layer can set this header.
    routingResult.internalEvent.headers[INTERNAL_HEADER_INITIAL_URL] ??
      routingResult.initialURL,
  );
  let invokeStatus: number | undefined;
  if (routingResult.internalEvent.rawPath === "/500") {
    invokeStatus = 500;
  } else if (routingResult.internalEvent.rawPath === "/404") {
    invokeStatus = 404;
  }
  const requestMetadata = {
    isNextDataReq: routingResult.internalEvent.query.__nextDataReq === "1",
    initURL: routingResult.initialURL,
    initQuery: convertToQuery(initialURL.search),
    initProtocol: initialURL.protocol,
    defaultLocale: NextConfig.i18n?.defaultLocale,
    locale: routingResult.locale,
    middlewareInvoke: false,
    // By setting invokePath and invokeQuery we can bypass some of the routing logic in Next.js
    invokePath: routingResult.internalEvent.rawPath,
    invokeQuery: routingResult.internalEvent.query,
    // invokeStatus is only used for error pages
    invokeStatus,
  };

  try {
    //#override applyNextjsPrebundledReact
    setNextjsPrebundledReact(routingResult.internalEvent.rawPath);
    //#endOverride

    // Next Server
    // TODO: only enable this on Next 15.4+
    // We need to set the pathname to the data request path
    //#override setInitialURL
    req.url =
      initialURL.pathname +
      convertToQueryString(routingResult.internalEvent.query);
    //#endOverride

    await requestHandler(requestMetadata)(req, res);
  } catch (e: any) {
    // This might fail when using bundled next, importing won't do the trick either
    if (e.constructor.name === "NoFallbackError") {
      await handleNoFallbackError(req, res, routingResult, requestMetadata);
    } else {
      error("NextJS request failed.", e);
      await tryRenderError("500", res, routingResult.internalEvent);
    }
  }
}

async function handleNoFallbackError(
  req: IncomingMessage,
  res: OpenNextNodeResponse,
  routingResult: RoutingResult,
  metadata: Record<string, unknown>,
  index = 1,
) {
  if (index >= 5) {
    await tryRenderError("500", res, routingResult.internalEvent);
    return;
  }
  if (index >= routingResult.resolvedRoutes.length) {
    await tryRenderError("404", res, routingResult.internalEvent);
    return;
  }
  try {
    await requestHandler({
      ...routingResult,
      invokeOutput: routingResult.resolvedRoutes[index].route,
      ...metadata,
    })(req, res);
  } catch (e: any) {
    if (e.constructor.name === "NoFallbackError") {
      await handleNoFallbackError(req, res, routingResult, metadata, index + 1);
    } else {
      error("NextJS request failed.", e);
      await tryRenderError("500", res, routingResult.internalEvent);
    }
  }
}

async function tryRenderError(
  type: "404" | "500",
  res: OpenNextNodeResponse,
  internalEvent: InternalEvent,
) {
  try {
    const _req = new IncomingMessage({
      method: "GET",
      url: `/${type}`,
      headers: internalEvent.headers,
      body: internalEvent.body,
      remoteAddress: internalEvent.remoteAddress,
    });
    // By setting this it will allow us to bypass and directly render the 404 or 500 page
    const requestMetadata = {
      // By setting invokePath and invokeQuery we can bypass some of the routing logic in Next.js
      invokePath: type === "404" ? "/404" : "/500",
      invokeStatus: type === "404" ? 404 : 500,
      middlewareInvoke: false,
    };
    await requestHandler(requestMetadata)(_req, res);
  } catch (e) {
    error("NextJS request failed.", e);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        {
          message: "Server failed to respond.",
          details: e,
        },
        null,
        2,
      ),
    );
  }
}
