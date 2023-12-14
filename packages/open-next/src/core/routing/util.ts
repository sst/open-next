import crypto from "node:crypto";
import { OutgoingHttpHeaders } from "node:http";
import { request } from "node:https";

import { BuildId, HtmlPages } from "config/index.js";
import type { IncomingMessage, StreamCreator } from "http/index.js";
import { OpenNextNodeResponse } from "http/openNextResponse.js";
import { parseHeaders } from "http/util.js";
import type { MiddlewareManifest } from "types/next-types";
import { InternalEvent } from "types/open-next.js";

import { isBinaryContentType } from "../../adapters/binary.js";
import { debug, error } from "../../adapters/logger.js";

/**
 *
 * @__PURE__
 */
export function isExternal(url?: string, host?: string) {
  if (!url) return false;
  const pattern = /^https?:\/\//;
  if (host) {
    return pattern.test(url) && !url.includes(host);
  }
  return pattern.test(url);
}

/**
 *
 * @__PURE__
 */
export function getUrlParts(url: string, isExternal: boolean) {
  // NOTE: when redirect to a URL that contains search query params,
  // compile breaks b/c it does not allow for the '?' character
  // We can't use encodeURIComponent because modal interception contains
  // characters that can't be encoded
  url = url.replaceAll("?", "%3F");
  if (!isExternal) {
    return {
      hostname: "",
      pathname: url,
      protocol: "",
    };
  }
  const { hostname, pathname, protocol } = new URL(url);
  return {
    hostname,
    pathname,
    protocol,
  };
}

/**
 *
 * @__PURE__
 */
export function convertRes(res: OpenNextNodeResponse) {
  // Format Next.js response to Lambda response
  const statusCode = res.statusCode || 200;
  const headers = parseHeaders(res.headers);
  const isBase64Encoded = isBinaryContentType(
    Array.isArray(headers["content-type"])
      ? headers["content-type"][0]
      : headers["content-type"],
  );
  const encoding = isBase64Encoded ? "base64" : "utf8";
  const body = res.body.toString(encoding);
  return {
    statusCode,
    headers,
    body,
    isBase64Encoded,
  };
}

/**
 * Make sure that multi-value query parameters are transformed to
 * ?key=value1&key=value2&... so that Next converts those parameters
 * to an array when reading the query parameters
 * @__PURE__
 */
export function convertToQueryString(query: Record<string, string | string[]>) {
  const urlQuery = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((entry) => urlQuery.append(key, entry));
    } else {
      urlQuery.append(key, value);
    }
  });
  const queryString = urlQuery.toString();

  return queryString ? `?${queryString}` : "";
}

/**
 * Given a raw query string, returns a record with key value-array pairs
 * similar to how multiValueQueryStringParameters are structured
 * @__PURE__
 */
export function convertToQuery(querystring: string) {
  const query = new URLSearchParams(querystring);
  const queryObject: Record<string, string[] | string> = {};

  for (const key of query.keys()) {
    const queries = query.getAll(key);
    queryObject[key] = queries.length > 1 ? queries : queries[0];
  }

  return queryObject;
}

/**
 *
 * @__PURE__
 */
export function getMiddlewareMatch(middlewareManifest: MiddlewareManifest) {
  const rootMiddleware = middlewareManifest.middleware["/"];
  if (!rootMiddleware?.matchers) return [];
  return rootMiddleware.matchers.map(({ regexp }) => new RegExp(regexp));
}

/**
 *
 * @__PURE__
 */
export function escapeRegex(str: string) {
  let path = str.replace(/\(\.\)/g, "_µ1_");

  path = path.replace(/\(\.{2}\)/g, "_µ2_");

  path = path.replace(/\(\.{3}\)/g, "_µ3_");

  return path;
}

/**
 *
 * @__PURE__
 */
export function unescapeRegex(str: string) {
  let path = str.replace(/_µ1_/g, "(.)");

  path = path.replace(/_µ2_/g, "(..)");

  path = path.replace(/_µ3_/g, "(...)");

  return path;
}

/**
 *
 * @__PURE__
 */
function filterHeadersForProxy(
  headers: Record<string, string | string[] | undefined>,
) {
  const filteredHeaders: Record<string, string | string[]> = {};
  const disallowedHeaders = [
    "host",
    "connection",
    "via",
    "x-cache",
    "transfer-encoding",
    "content-encoding",
  ];
  Object.entries(headers).forEach(([key, value]) => {
    const lowerKey = key.toLowerCase();
    if (disallowedHeaders.includes(lowerKey) || lowerKey.startsWith("x-amz"))
      return;
    else {
      filteredHeaders[key] = value?.toString() ?? "";
    }
  });
  return filteredHeaders;
}

/**
 * @__PURE__
 */
export function convertBodyToReadableStream(
  method: string,
  body?: string | Buffer,
) {
  if (method === "GET" || method === "HEAD") return undefined;
  if (!body) return undefined;
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  });
  return readable;
}

/**
 *
 * @__PURE__
 */
export async function proxyRequest(
  internalEvent: InternalEvent,
  res: OpenNextNodeResponse,
) {
  const { url, headers, method, body } = internalEvent;
  debug("proxyRequest", url);
  await new Promise<void>((resolve, reject) => {
    const filteredHeaders = filterHeadersForProxy(headers);
    debug("filteredHeaders", filteredHeaders);
    const req = request(
      url,
      {
        headers: filteredHeaders,
        method,
        rejectUnauthorized: false,
      },
      (_res) => {
        res.writeHead(
          _res.statusCode ?? 200,
          filterHeadersForProxy(_res.headers),
        );
        if (_res.headers["content-encoding"] === "br") {
          _res.pipe(require("node:zlib").createBrotliDecompress()).pipe(res);
        } else if (_res.headers["content-encoding"] === "gzip") {
          _res.pipe(require("node:zlib").createGunzip()).pipe(res);
        } else {
          _res.pipe(res);
        }

        _res.on("error", (e) => {
          error("proxyRequest error", e);
          res.end();
          reject(e);
        });
        _res.on("end", () => {
          resolve();
        });
      },
    );

    if (body && method !== "GET" && method !== "HEAD") {
      req.write(body);
    }
    req.end();
  });
  // console.log("result", result);
  // res.writeHead(result.status, resHeaders);
  // res.end(await result.text());
}

declare global {
  var openNextDebug: boolean;
  var openNextVersion: string;
  var lastModified: number;
}

enum CommonHeaders {
  CACHE_CONTROL = "cache-control",
  NEXT_CACHE = "x-nextjs-cache",
}

/**
 *
 * @__PURE__
 */
export function fixCacheHeaderForHtmlPages(
  rawPath: string,
  headers: OutgoingHttpHeaders,
) {
  // WORKAROUND: `NextServer` does not set cache headers for HTML pages — https://github.com/serverless-stack/open-next#workaround-nextserver-does-not-set-cache-headers-for-html-pages
  if (HtmlPages.includes(rawPath) && headers[CommonHeaders.CACHE_CONTROL]) {
    headers[CommonHeaders.CACHE_CONTROL] =
      "public, max-age=0, s-maxage=31536000, must-revalidate";
  }
}

/**
 *
 * @__PURE__
 */
export function fixSWRCacheHeader(headers: OutgoingHttpHeaders) {
  // WORKAROUND: `NextServer` does not set correct SWR cache headers — https://github.com/serverless-stack/open-next#workaround-nextserver-does-not-set-correct-swr-cache-headers
  let cacheControl = headers[CommonHeaders.CACHE_CONTROL];
  if (!cacheControl) return;
  if (Array.isArray(cacheControl)) {
    cacheControl = cacheControl.join(",");
  }
  if (typeof cacheControl !== "string") return;
  headers[CommonHeaders.CACHE_CONTROL] = cacheControl.replace(
    /\bstale-while-revalidate(?!=)/,
    "stale-while-revalidate=2592000", // 30 days
  );
}

/**
 *
 * @__PURE__
 */
export function addOpenNextHeader(headers: OutgoingHttpHeaders) {
  headers["X-OpenNext"] = "1";
  if (globalThis.openNextDebug) {
    headers["X-OpenNext-Version"] = globalThis.openNextVersion;
  }
}

/**
 *
 * @__PURE__
 */
export async function revalidateIfRequired(
  host: string,
  rawPath: string,
  headers: OutgoingHttpHeaders,
  req?: IncomingMessage,
) {
  fixISRHeaders(headers);

  if (headers[CommonHeaders.NEXT_CACHE] === "STALE") {
    // If the URL is rewritten, revalidation needs to be done on the rewritten URL.
    // - Link to Next.js doc: https://nextjs.org/docs/pages/building-your-application/data-fetching/incremental-static-regeneration#on-demand-revalidation
    // - Link to NextInternalRequestMeta: https://github.com/vercel/next.js/blob/57ab2818b93627e91c937a130fb56a36c41629c3/packages/next/src/server/request-meta.ts#L11
    // @ts-ignore
    const internalMeta = req?.[Symbol.for("NextInternalRequestMeta")];

    // When using Pages Router, two requests will be received:
    // 1. one for the page: /foo
    // 2. one for the json data: /_next/data/BUILD_ID/foo.json
    // The rewritten url is correct for 1, but that for the second request
    // does not include the "/_next/data/" prefix. Need to add it.
    const revalidateUrl = internalMeta?._nextDidRewrite
      ? rawPath.startsWith("/_next/data/")
        ? `/_next/data/${BuildId}${internalMeta?._nextRewroteUrl}.json`
        : internalMeta?._nextRewroteUrl
      : rawPath;

    // We need to pass etag to the revalidation queue to try to bypass the default 5 min deduplication window.
    // https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/using-messagededuplicationid-property.html
    // If you need to have a revalidation happen more frequently than 5 minutes,
    // your page will need to have a different etag to bypass the deduplication window.
    // If data has the same etag during these 5 min dedup window, it will be deduplicated and not revalidated.
    try {
      const hash = (str: string) =>
        crypto.createHash("md5").update(str).digest("hex");

      const lastModified =
        globalThis.lastModified > 0 ? globalThis.lastModified : "";

      // await sqsClient.send(
      //   new SendMessageCommand({
      //     QueueUrl: REVALIDATION_QUEUE_URL,
      //     MessageDeduplicationId: hash(`${rawPath}-${lastModified}`),
      //     MessageBody: JSON.stringify({ host, url: revalidateUrl }),
      //     MessageGroupId: generateMessageGroupId(rawPath),
      //   }),
      // );

      await globalThis.queue.send({
        MessageBody: { host, url: revalidateUrl },
        MessageDeduplicationId: hash(`${rawPath}-${lastModified}`),
        MessageGroupId: generateMessageGroupId(rawPath),
      });
    } catch (e) {
      debug(`Failed to revalidate stale page ${rawPath}`);
      debug(e);
    }
  }
}

// Since we're using a FIFO queue, every messageGroupId is treated sequentially
// This could cause a backlog of messages in the queue if there is too much page to
// revalidate at once. To avoid this, we generate a random messageGroupId for each
// revalidation request.
// We can't just use a random string because we need to ensure that the same rawPath
// will always have the same messageGroupId.
// https://stackoverflow.com/questions/521295/seeding-the-random-number-generator-in-javascript#answer-47593316
function generateMessageGroupId(rawPath: string) {
  let a = cyrb128(rawPath);
  // We use mulberry32 to generate a random int between 0 and MAX_REVALIDATE_CONCURRENCY
  var t = (a += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const randomFloat = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  // This will generate a random int between 0 and MAX_REVALIDATE_CONCURRENCY
  // This means that we could have 1000 revalidate request at the same time
  const maxConcurrency = parseInt(
    process.env.MAX_REVALIDATE_CONCURRENCY ?? "10",
  );
  const randomInt = Math.floor(randomFloat * maxConcurrency);
  return `revalidate-${randomInt}`;
}

// Used to generate a hash int from a string
function cyrb128(str: string) {
  let h1 = 1779033703,
    h2 = 3144134277,
    h3 = 1013904242,
    h4 = 2773480762;
  for (let i = 0, k; i < str.length; i++) {
    k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  (h1 ^= h2 ^ h3 ^ h4), (h2 ^= h1), (h3 ^= h1), (h4 ^= h1);
  return h1 >>> 0;
}

/**
 *
 * @__PURE__
 */
export function fixISRHeaders(headers: OutgoingHttpHeaders) {
  if (headers[CommonHeaders.NEXT_CACHE] === "REVALIDATED") {
    headers[CommonHeaders.CACHE_CONTROL] =
      "private, no-cache, no-store, max-age=0, must-revalidate";
    return;
  }
  if (
    headers[CommonHeaders.NEXT_CACHE] === "HIT" &&
    globalThis.lastModified > 0
  ) {
    // calculate age
    const age = Math.round((Date.now() - globalThis.lastModified) / 1000);
    // extract s-maxage from cache-control
    const regex = /s-maxage=(\d+)/;
    const cacheControl = headers[CommonHeaders.CACHE_CONTROL];
    debug("cache-control", cacheControl, globalThis.lastModified, Date.now());
    if (typeof cacheControl !== "string") return;
    const match = cacheControl.match(regex);
    const sMaxAge = match ? parseInt(match[1]) : undefined;

    // 31536000 is the default s-maxage value for SSG pages
    if (sMaxAge && sMaxAge !== 31536000) {
      const remainingTtl = Math.max(sMaxAge - age, 1);
      headers[
        CommonHeaders.CACHE_CONTROL
      ] = `s-maxage=${remainingTtl}, stale-while-revalidate=2592000`;
    }

    // reset lastModified
    globalThis.lastModified = 0;
  }
  if (headers[CommonHeaders.NEXT_CACHE] !== "STALE") return;

  // If the cache is stale, we revalidate in the background
  // In order for CloudFront SWR to work, we set the stale-while-revalidate value to 2 seconds
  // This will cause CloudFront to cache the stale data for a short period of time while we revalidate in the background
  // Once the revalidation is complete, CloudFront will serve the fresh data
  headers[CommonHeaders.CACHE_CONTROL] =
    "s-maxage=2, stale-while-revalidate=2592000";
}

/**
 *
 * @param internalEvent
 * @param headers
 * @param responseStream
 * @returns
 * @__PURE__
 */
export function createServerResponse(
  internalEvent: InternalEvent,
  headers: Record<string, string | string[] | undefined>,
  responseStream?: StreamCreator,
) {
  return new OpenNextNodeResponse(
    (_headers) => {
      fixCacheHeaderForHtmlPages(internalEvent.rawPath, _headers);
      fixSWRCacheHeader(_headers);
      addOpenNextHeader(_headers);
      fixISRHeaders(_headers);
    },
    async (_headers) => {
      await revalidateIfRequired(
        internalEvent.headers.host,
        internalEvent.rawPath,
        _headers,
      );
    },
    responseStream,
    headers,
  );
}
