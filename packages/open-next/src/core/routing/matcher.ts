import { NextConfig } from "config/index";
import type { Match, MatchFunction, PathFunction } from "path-to-regexp";
import { compile, match } from "path-to-regexp";
import type {
  Header,
  PrerenderManifest,
  RedirectDefinition,
  RewriteDefinition,
  RouteHas,
} from "types/next-types";
import type { InternalEvent, InternalResult } from "types/open-next";
import { normalizeRepeatedSlashes } from "utils/normalize-path";
import { emptyReadableStream, toReadableStream } from "utils/stream";

import { debug } from "../../adapters/logger";
import { handleLocaleRedirect, localizePath } from "./i18n";
import { dynamicRouteMatcher, staticRouteMatcher } from "./routeMatcher";
import {
  constructNextUrl,
  convertFromQueryString,
  convertToQueryString,
  escapeRegex,
  getUrlParts,
  isExternal,
  unescapeRegex,
} from "./util";

function matchHasValue(
  value: string | string[] | undefined,
  pattern?: string,
): boolean {
  const candidate = Array.isArray(value) ? value.at(-1) : value;
  if (!candidate) return false;
  return pattern ? new RegExp(`^${pattern}$`).test(candidate) : true;
}

const routeHasMatcher =
  (
    headers: Record<string, string>,
    cookies: Record<string, string>,
    query: Record<string, string | string[]>,
  ) =>
  (redirect: RouteHas): boolean => {
    switch (redirect.type) {
      case "header":
        return matchHasValue(
          headers[redirect.key.toLowerCase()],
          redirect.value,
        );
      case "cookie":
        return matchHasValue(cookies[redirect.key], redirect.value);
      case "query":
        return matchHasValue(query[redirect.key], redirect.value);
      case "host":
        return matchHasValue(
          headers.host?.split(":", 1)[0].toLowerCase(),
          redirect.value,
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

const getParamsFromSource =
  (source: MatchFunction<object>) => (value: string) => {
    debug("value", value);
    const _match = source(value);
    return _match ? _match.params : {};
  };

const computeParamHas =
  (
    headers: Record<string, string>,
    cookies: Record<string, string>,
    query: Record<string, string | string[]>,
  ) =>
  (has: RouteHas): object => {
    if (!has.value) return {};
    const matcher = new RegExp(`^${has.value}$`);
    const fromSource = (value: string) => {
      const matches = value.match(matcher);
      return matches?.groups ?? {};
    };
    switch (has.type) {
      case "header":
        return fromSource(headers[has.key.toLowerCase()] ?? "");
      case "cookie":
        return fromSource(cookies[has.key] ?? "");
      case "query":
        return Array.isArray(query[has.key])
          ? fromSource((query[has.key] as string[]).join(","))
          : fromSource((query[has.key] as string) ?? "");
      case "host":
        return fromSource(headers.host ?? "");
    }
  };

function convertMatch(
  match: Match,
  toDestination: PathFunction,
  destination: string,
) {
  if (!match) {
    return destination;
  }

  const { params } = match;
  const isUsingParams = Object.keys(params).length > 0;
  return isUsingParams ? toDestination(params) : destination;
}

export function getNextConfigHeaders(
  event: InternalEvent,
  configHeaders?: Header[] | undefined,
): Record<string, string | undefined> {
  if (!configHeaders) {
    return {};
  }

  const matcher = routeHasMatcher(event.headers, event.cookies, event.query);

  const requestHeaders: Record<string, string> = {};
  const localizedRawPath = localizePath(event);

  for (const {
    headers,
    has,
    missing,
    regex,
    source,
    locale,
  } of configHeaders) {
    const path = locale === false ? event.rawPath : localizedRawPath;
    if (
      new RegExp(regex).test(path) &&
      checkHas(matcher, has) &&
      checkHas(matcher, missing, true)
    ) {
      const fromSource = match(source);
      const _match = fromSource(path);
      headers.forEach((h) => {
        try {
          const key = convertMatch(_match, compile(h.key), h.key);
          const value = convertMatch(_match, compile(h.value), h.value);
          requestHeaders[key] = value;
        } catch {
          debug(`Error matching header ${h.key} with value ${h.value}`);
          requestHeaders[h.key] = h.value;
        }
      });
    }
  }
  return requestHeaders;
}

/**
 * TODO: This method currently only check for the first match.
 *       It should check for all matches for `beforeFiles` and `afterFiles` rewrite
 *       See https://nextjs.org/docs/app/api-reference/config/next-config-js/rewrites
 */
export function handleRewrites<T extends RewriteDefinition>(
  event: InternalEvent,
  rewrites: T[],
) {
  const { rawPath, headers, query, cookies, url } = event;
  const localizedRawPath = localizePath(event);
  const matcher = routeHasMatcher(headers, cookies, query);
  const computeHas = computeParamHas(headers, cookies, query);
  const rewrite = rewrites.find((route) => {
    const path = route.locale === false ? rawPath : localizedRawPath;
    return (
      new RegExp(route.regex).test(path) &&
      checkHas(matcher, route.has) &&
      checkHas(matcher, route.missing, true)
    );
  });
  let finalQuery = query;

  let rewrittenUrl = url;
  const isExternalRewrite = isExternal(rewrite?.destination);
  debug("isExternalRewrite", isExternalRewrite);
  if (rewrite) {
    const { pathname, protocol, hostname, queryString } = getUrlParts(
      rewrite.destination,
      isExternalRewrite,
    );
    // We need to use a localized path if the rewrite is not locale specific
    const pathToUse = rewrite.locale === false ? rawPath : localizedRawPath;

    debug("urlParts", { pathname, protocol, hostname, queryString });
    const toDestinationPath = compile(escapeRegex(pathname, { isPath: true }));
    const toDestinationHost = compile(escapeRegex(hostname));
    const toDestinationQuery = compile(escapeRegex(queryString));
    const params = {
      // params for the source
      ...getParamsFromSource(
        match(escapeRegex(rewrite.source, { isPath: true })),
      )(pathToUse),
      // params for the has
      ...rewrite.has?.reduce((acc, cur) => {
        return Object.assign(acc, computeHas(cur));
      }, {}),
      // params for the missing
      ...rewrite.missing?.reduce((acc, cur) => {
        return Object.assign(acc, computeHas(cur));
      }, {}),
    };
    const isUsingParams = Object.keys(params).length > 0;
    let rewrittenQuery = queryString;
    let rewrittenHost = hostname;
    let rewrittenPath = pathname;
    if (isUsingParams) {
      rewrittenPath = unescapeRegex(toDestinationPath(params));
      rewrittenHost = unescapeRegex(toDestinationHost(params));
      rewrittenQuery = unescapeRegex(toDestinationQuery(params));
    }

    // We need to strip the locale from the path if it's a local api route
    if (NextConfig.i18n && !isExternalRewrite) {
      const strippedPathLocale = rewrittenPath.replace(
        new RegExp(`^/(${NextConfig.i18n.locales.join("|")})`),
        "",
      );
      if (strippedPathLocale.startsWith("/api/")) {
        rewrittenPath = strippedPathLocale;
      }
    }

    rewrittenUrl = isExternalRewrite
      ? `${protocol}//${rewrittenHost}${rewrittenPath}`
      : new URL(rewrittenPath, event.url).href;

    // We merge query params from the source and the destination
    finalQuery = {
      ...query,
      ...convertFromQueryString(rewrittenQuery),
    };
    rewrittenUrl += convertToQueryString(finalQuery);
    debug("rewrittenUrl", { rewrittenUrl, finalQuery, isUsingParams });
  }

  return {
    internalEvent: {
      ...event,
      query: finalQuery,
      rawPath: new URL(rewrittenUrl).pathname,
      url: rewrittenUrl,
    },
    __rewrite: rewrite,
    isExternalRewrite,
  };
}

// Normalizes repeated slashes in the path e.g. hello//world -> hello/world
// or backslashes to forward slashes. This prevents requests such as //domain
// from invoking the middleware with `request.url === "domain"`.
// See: https://github.com/vercel/next.js/blob/3ecf087f10fdfba4426daa02b459387bc9c3c54f/packages/next/src/server/base-server.ts#L1016-L1020
function handleRepeatedSlashRedirect(
  event: InternalEvent,
): false | InternalResult {
  // Redirect `https://example.com//foo` to `https://example.com/foo`.
  if (event.rawPath.match(/(\\|\/\/)/)) {
    return {
      type: event.type,
      statusCode: 308,
      headers: {
        Location: normalizeRepeatedSlashes(new URL(event.url)),
      },
      body: emptyReadableStream(),
      isBase64Encoded: false,
    };
  }

  return false;
}

function handleTrailingSlashRedirect(
  event: InternalEvent,
): false | InternalResult {
  // When rawPath is `//domain`, `url.host` would be `domain`.
  // https://github.com/opennextjs/opennextjs-aws/issues/355
  const url = new URL(event.rawPath, "http://localhost");

  if (
    // Someone is trying to redirect to a different origin, let's not do that
    url.host !== "localhost" ||
    NextConfig.skipTrailingSlashRedirect ||
    // We should not apply trailing slash redirect to API routes
    event.rawPath.startsWith("/api/")
  ) {
    return false;
  }

  const emptyBody = emptyReadableStream();

  if (
    NextConfig.trailingSlash &&
    !(event.query.__nextDataReq === "1") &&
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
      body: emptyBody,
      isBase64Encoded: false,
    };
    // eslint-disable-next-line sonarjs/elseif-without-else
  }
  if (
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
      body: emptyBody,
      isBase64Encoded: false,
    };
  }
  return false;
}

export function handleRedirects(
  event: InternalEvent,
  redirects: RedirectDefinition[],
): InternalResult | undefined {
  const repeatedSlashRedirect = handleRepeatedSlashRedirect(event);
  if (repeatedSlashRedirect) return repeatedSlashRedirect;

  const trailingSlashRedirect = handleTrailingSlashRedirect(event);
  if (trailingSlashRedirect) return trailingSlashRedirect;

  const localeRedirect = handleLocaleRedirect(event);
  if (localeRedirect) return localeRedirect;

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
      body: emptyReadableStream(),
      isBase64Encoded: false,
    };
  }
}

export function fixDataPage(
  internalEvent: InternalEvent,
  buildId: string,
): InternalEvent | InternalResult {
  const { rawPath, query } = internalEvent;
  const basePath = NextConfig.basePath ?? "";
  const dataPattern = `${basePath}/_next/data/${buildId}`;
  // Return 404 for data requests that don't match the buildId
  if (rawPath.startsWith("/_next/data") && !rawPath.startsWith(dataPattern)) {
    return {
      type: internalEvent.type,
      statusCode: 404,
      body: toReadableStream("{}"),
      headers: {
        "Content-Type": "application/json",
      },
      isBase64Encoded: false,
    };
  }

  if (rawPath.startsWith(dataPattern) && rawPath.endsWith(".json")) {
    const newPath = `${basePath}${rawPath
      .slice(dataPattern.length, -".json".length)
      .replace(/^\/index$/, "/")}`;
    query.__nextDataReq = "1";

    return {
      ...internalEvent,
      rawPath: newPath,
      query,
      headers: {
        ...internalEvent.headers,
        "x-nextjs-data": "1",
      },
      url: new URL(
        `${newPath}${convertToQueryString(query)}`,
        internalEvent.url,
      ).href,
    };
  }
  return internalEvent;
}

export function handleFallbackFalse(
  internalEvent: InternalEvent,
  prerenderManifest?: PrerenderManifest,
): { event: InternalEvent; isISR: boolean } {
  const { rawPath } = internalEvent;
  const { dynamicRoutes = {}, routes = {} } = prerenderManifest ?? {};
  const prerenderedFallbackRoutes = Object.entries(dynamicRoutes).filter(
    ([, { fallback }]) => fallback === false,
  );
  const routeFallback = prerenderedFallbackRoutes.some(([, { routeRegex }]) => {
    const routeRegexExp = new RegExp(routeRegex);
    return routeRegexExp.test(rawPath);
  });
  const locales = NextConfig.i18n?.locales;
  const routesAlreadyHaveLocale =
    locales?.includes(rawPath.split("/")[1]) ||
    // If we don't use locales, we don't need to add the default locale
    locales === undefined;
  let localizedPath = routesAlreadyHaveLocale
    ? rawPath
    : `/${NextConfig.i18n?.defaultLocale}${rawPath}`;
  // We need to remove the trailing slash if it exists
  if (
    // Not if localizedPath is "/" tho, because that would not make it find `isPregenerated` below since it would be try to match an empty string.
    localizedPath !== "/" &&
    NextConfig.trailingSlash &&
    localizedPath.endsWith("/")
  ) {
    localizedPath = localizedPath.slice(0, -1);
  }
  const matchedStaticRoute = staticRouteMatcher(localizedPath);
  const prerenderedFallbackRoutesName = prerenderedFallbackRoutes.map(
    ([name]) => name,
  );
  const matchedDynamicRoute = dynamicRouteMatcher(localizedPath).filter(
    ({ route }) => !prerenderedFallbackRoutesName.includes(route),
  );

  const isPregenerated = Object.keys(routes).includes(localizedPath);
  if (
    routeFallback &&
    !isPregenerated &&
    matchedStaticRoute.length === 0 &&
    matchedDynamicRoute.length === 0
  ) {
    return {
      event: {
        ...internalEvent,
        rawPath: "/404",
        url: constructNextUrl(internalEvent.url, "/404"),
        headers: {
          ...internalEvent.headers,
          "x-invoke-status": "404",
        },
      },
      isISR: false,
    };
  }

  return {
    event: internalEvent,
    isISR: routeFallback || isPregenerated,
  };
}
