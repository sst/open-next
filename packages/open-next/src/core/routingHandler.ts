import {
  BuildId,
  ConfigHeaders,
  PrerenderManifest,
  RoutesManifest,
} from "config/index";
import type { OutgoingHttpHeaders } from "http";
import { InternalEvent, InternalResult, Origin } from "types/open-next";

import { debug } from "../adapters/logger";
import {
  addNextConfigHeaders,
  fixDataPage,
  handleFallbackFalse,
  handleRedirects,
  handleRewrites,
} from "./routing/matcher";
import { handleMiddleware } from "./routing/middleware";

export interface MiddlewareOutputEvent {
  internalEvent: InternalEvent;
  headers: OutgoingHttpHeaders;
  isExternalRewrite: boolean;
  origin: Origin | false;
}

export default async function routingHandler(
  event: InternalEvent,
): Promise<InternalResult | MiddlewareOutputEvent> {
  const nextHeaders = addNextConfigHeaders(event, ConfigHeaders) ?? {};

  let internalEvent = fixDataPage(event, BuildId);

  internalEvent = handleFallbackFalse(internalEvent, PrerenderManifest);

  const redirect = handleRedirects(internalEvent, RoutesManifest.redirects);
  if (redirect) {
    debug("redirect", redirect);
    return redirect;
  }

  const middleware = await handleMiddleware(internalEvent);
  let middlewareResponseHeaders: Record<string, string | string[]> = {};
  if ("statusCode" in middleware) {
    return middleware;
  } else {
    middlewareResponseHeaders = middleware.responseHeaders || {};
    internalEvent = middleware;
  }

  let isExternalRewrite = middleware.externalRewrite ?? false;
  if (!isExternalRewrite) {
    // First rewrite to be applied
    const beforeRewrites = handleRewrites(
      internalEvent,
      RoutesManifest.rewrites.beforeFiles,
    );
    internalEvent = beforeRewrites.internalEvent;
    isExternalRewrite = beforeRewrites.isExternalRewrite;
  }
  const isStaticRoute = RoutesManifest.routes.static.some((route) =>
    new RegExp(route.regex).test(event.rawPath),
  );

  if (!isStaticRoute && !isExternalRewrite) {
    // Second rewrite to be applied
    const afterRewrites = handleRewrites(
      internalEvent,
      RoutesManifest.rewrites.afterFiles,
    );
    internalEvent = afterRewrites.internalEvent;
    isExternalRewrite = afterRewrites.isExternalRewrite;
  }

  const isDynamicRoute = RoutesManifest.routes.dynamic.some((route) =>
    new RegExp(route.regex).test(event.rawPath),
  );
  if (!isDynamicRoute && !isStaticRoute && !isExternalRewrite) {
    // Fallback rewrite to be applied
    const fallbackRewrites = handleRewrites(
      internalEvent,
      RoutesManifest.rewrites.fallback,
    );
    internalEvent = fallbackRewrites.internalEvent;
    isExternalRewrite = fallbackRewrites.isExternalRewrite;
  }

  return {
    internalEvent,
    headers: {
      ...nextHeaders,
      ...middlewareResponseHeaders,
    },
    isExternalRewrite,
    origin: false,
  };
}
