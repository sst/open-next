import { NextConfig } from "config/index";
import { compile, Match, match, PathFunction } from "path-to-regexp";
import type {
  Header,
  PrerenderManifest,
  RedirectDefinition,
  RewriteDefinition,
  RouteHas,
} from "types/next-types";
import { InternalEvent, InternalResult } from "types/open-next";

import { debug } from "../../adapters/logger";
import {
  convertToQueryString,
  escapeRegex,
  getUrlParts,
  isExternal,
  unescapeRegex,
} from "./util";

const routeHasMatcher =
  (
    headers: Record<string, string>,
    cookies: Record<string, string>,
    query: Record<string, string | string[]>,
  ) =>
  (redirect: RouteHas): boolean => {
    switch (redirect.type) {
      case "header":
        return (
          !!headers?.[redirect.key.toLowerCase()] &&
          new RegExp(redirect.value ?? "").test(
            headers[redirect.key.toLowerCase()] ?? "",
          )
        );
      case "cookie":
        return (
          !!cookies?.[redirect.key] &&
          new RegExp(redirect.value ?? "").test(cookies[redirect.key] ?? "")
        );
      case "query":
        return query[redirect.key] && Array.isArray(redirect.value)
          ? redirect.value.reduce(
              (prev, current) =>
                prev || new RegExp(current).test(query[redirect.key] as string),
              false,
            )
          : new RegExp(redirect.value ?? "").test(
              (query[redirect.key] as string | undefined) ?? "",
            );
      case "host":
        return (
          headers?.host !== "" &&
          new RegExp(redirect.value ?? "").test(headers.host)
        );
      default:
        return false;
    }
  };

function checkHas(
  matcher: ReturnType<typeof routeHasMatcher>,
  has?: RouteHas[],
  inverted = false,
) {
  return has
    ? has.reduce((acc, cur) => {
        if (acc === false) return false;
        return inverted ? !matcher(cur) : matcher(cur);
      }, true)
    : true;
}

function convertMatch(
  match: Match,
  toDestination: PathFunction,
  destination: string,
) {
  if (match) {
    const { params } = match;
    const isUsingParams = Object.keys(params).length > 0;
    if (isUsingParams) {
      return toDestination(params);
    } else {
      return destination;
    }
  } else {
    return destination;
  }
}

export function addNextConfigHeaders(
  event: InternalEvent,
  configHeaders?: Header[] | undefined,
) {
  const addedHeaders: Record<string, string | undefined> = {};

  if (!configHeaders) return addedHeaders;
  const { rawPath, headers, query, cookies } = event;
  const matcher = routeHasMatcher(headers, cookies, query);

  const requestHeaders: Record<string, string> = {};

  for (const { headers, has, missing, regex, source } of configHeaders) {
    if (
      new RegExp(regex).test(rawPath) &&
      checkHas(matcher, has) &&
      checkHas(matcher, missing, true)
    ) {
      const fromSource = match(source);
      const _match = fromSource(rawPath);
      headers.forEach((h) => {
        const key = convertMatch(_match, compile(h.key), h.key);
        const value = convertMatch(_match, compile(h.value), h.value);
        requestHeaders[key] = value;
      });
    }
  }
  return requestHeaders;
}

export function handleRewrites<T extends RewriteDefinition>(
  event: InternalEvent,
  rewrites: T[],
) {
  const { rawPath, headers, query, cookies } = event;
  const matcher = routeHasMatcher(headers, cookies, query);
  const rewrite = rewrites.find(
    (route) =>
      new RegExp(route.regex).test(rawPath) &&
      checkHas(matcher, route.has) &&
      checkHas(matcher, route.missing, true),
  );

  let rewrittenUrl = rawPath;
  const isExternalRewrite = isExternal(rewrite?.destination);
  debug("isExternalRewrite", isExternalRewrite);
  if (rewrite) {
    const { pathname, protocol, hostname } = getUrlParts(
      rewrite.destination,
      isExternalRewrite,
    );
    const toDestination = compile(escapeRegex(pathname ?? "") ?? "");
    const fromSource = match(escapeRegex(rewrite?.source) ?? "");
    const _match = fromSource(rawPath);
    if (_match) {
      const { params } = _match;
      const isUsingParams = Object.keys(params).length > 0;
      if (isUsingParams) {
        const rewrittenPath = unescapeRegex(toDestination(params));
        rewrittenUrl = isExternalRewrite
          ? `${protocol}//${hostname}${rewrittenPath}`
          : `${rewrittenPath}`;
      } else {
        rewrittenUrl = rewrite.destination;
      }
      debug("rewrittenUrl", rewrittenUrl);
    }
  }

  return {
    internalEvent: {
      ...event,
      rawPath: rewrittenUrl,
      url: `${rewrittenUrl}${convertToQueryString(query)}`,
    },
    __rewrite: rewrite,
    isExternalRewrite,
  };
}

export function handleRedirects(
  event: InternalEvent,
  redirects: RedirectDefinition[],
): InternalResult | undefined {
  if (
    NextConfig.trailingSlash &&
    !event.headers["x-nextjs-data"] &&
    !event.rawPath.endsWith("/") &&
    !event.rawPath.match(/[\w-]+\.[\w]+$/g)
  ) {
    const headersLocation = event.url.split("?");
    return {
      type: event.type,
      statusCode: 308,
      headers: {
        Location: `${headersLocation[0]}/${
          headersLocation[1] ? `?${headersLocation[1]}` : ""
        }`,
      },
      body: "",
      isBase64Encoded: false,
    };
    // eslint-disable-next-line sonarjs/elseif-without-else
  } else if (
    !NextConfig.trailingSlash &&
    event.rawPath.endsWith("/") &&
    event.rawPath !== "/"
  ) {
    const headersLocation = event.url.split("?");
    return {
      type: event.type,
      statusCode: 308,
      headers: {
        Location: `${headersLocation[0].replace(/\/$/, "")}${
          headersLocation[1] ? `?${headersLocation[1]}` : ""
        }`,
      },
      body: "",
      isBase64Encoded: false,
    };
  }
  const { internalEvent, __rewrite } = handleRewrites(
    event,
    redirects.filter((r) => !r.internal),
  );
  if (__rewrite && !__rewrite.internal) {
    return {
      type: event.type,
      statusCode: __rewrite.statusCode ?? 308,
      headers: {
        Location: internalEvent.url,
      },
      body: "",
      isBase64Encoded: false,
    };
  }
}

export function fixDataPage(internalEvent: InternalEvent, buildId: string) {
  const { rawPath, query } = internalEvent;
  const dataPattern = `/_next/data/${buildId}`;

  if (rawPath.startsWith(dataPattern) && rawPath.endsWith(".json")) {
    let newPath = rawPath.replace(dataPattern, "").replace(/\.json$/, "");
    newPath = newPath === "/index" ? "/" : newPath;
    query.__nextDataReq = "1";

    return {
      ...internalEvent,
      rawPath: newPath,
      query,
      url: `${newPath}${convertToQueryString(query)}`,
    };
  }
  return internalEvent;
}

export function handleFallbackFalse(
  internalEvent: InternalEvent,
  prerenderManifest: PrerenderManifest,
): InternalEvent {
  const { rawPath } = internalEvent;
  const { dynamicRoutes, routes } = prerenderManifest;
  const routeFallback = Object.entries(dynamicRoutes)
    .filter(([, { fallback }]) => fallback === false)
    .some(([, { routeRegex }]) => {
      const routeRegexExp = new RegExp(routeRegex);
      return routeRegexExp.test(rawPath);
    });
  if (routeFallback && !Object.keys(routes).includes(rawPath)) {
    return {
      ...internalEvent,
      rawPath: "/404",
      url: "/404",
      headers: {
        ...internalEvent.headers,
        "x-invoke-status": "404",
      },
    };
  }

  return internalEvent;
}
