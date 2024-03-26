import type {
  APIGatewayProxyEvent,
  APIGatewayProxyEventV2,
  APIGatewayProxyResult,
  APIGatewayProxyResultV2,
  CloudFrontHeaders,
  CloudFrontRequestEvent,
  CloudFrontRequestResult,
} from "aws-lambda";

import { debug } from "./logger.js";
import { convertToQuery } from "./routing/util.js";
import { parseCookies } from "./util.js";

export type InternalEvent = {
  readonly type: "v1" | "v2" | "cf";
  readonly method: string;
  readonly rawPath: string;
  readonly url: string;
  readonly body: Buffer;
  readonly headers: Record<string, string>;
  readonly query: Record<string, string | string[]>;
  readonly cookies: Record<string, string>;
  readonly remoteAddress: string;
};

export type InternalResult = {
  readonly type: "v1" | "v2" | "cf";
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  isBase64Encoded: boolean;
};

export function isAPIGatewayProxyEventV2(
  event: any,
): event is APIGatewayProxyEventV2 {
  return event.version === "2.0";
}

export function isAPIGatewayProxyEvent(
  event: any,
): event is APIGatewayProxyEvent {
  return event.version === undefined && !isCloudFrontRequestEvent(event);
}

export function isCloudFrontRequestEvent(
  event: any,
): event is CloudFrontRequestEvent {
  return event.Records !== undefined;
}

export function convertFrom(
  event: APIGatewayProxyEventV2 | APIGatewayProxyEvent | CloudFrontRequestEvent,
): InternalEvent {
  let internalEvent: InternalEvent;
  if (isCloudFrontRequestEvent(event)) {
    internalEvent = convertFromCloudFrontRequestEvent(event);
  } else if (isAPIGatewayProxyEventV2(event)) {
    internalEvent = convertFromAPIGatewayProxyEventV2(event);
  } else if (isAPIGatewayProxyEvent(event)) {
    internalEvent = convertFromAPIGatewayProxyEvent(event);
  } else throw new Error("Unsupported event type");

  return internalEvent;
}

export function convertTo(
  result: InternalResult,
): APIGatewayProxyResultV2 | APIGatewayProxyResult | CloudFrontRequestResult {
  if (result.type === "v2") {
    return convertToApiGatewayProxyResultV2(result);
  } else if (result.type === "v1") {
    return convertToApiGatewayProxyResult(result);
  } else if (result.type === "cf") {
    return convertToCloudFrontRequestResult(result);
  }
  throw new Error("Unsupported event type");
}

function removeUndefinedFromQuery(
  query: Record<string, string | string[] | undefined>,
) {
  const newQuery: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      newQuery[key] = value;
    }
  }
  return newQuery;
}
function convertFromAPIGatewayProxyEvent(
  event: APIGatewayProxyEvent,
): InternalEvent {
  const { path, body, httpMethod, requestContext, isBase64Encoded } = event;
  return {
    type: "v1",
    method: httpMethod,
    rawPath: path,
    url: path + normalizeAPIGatewayProxyEventQueryParams(event),
    body: Buffer.from(body ?? "", isBase64Encoded ? "base64" : "utf8"),
    headers: normalizeAPIGatewayProxyEventHeaders(event),
    remoteAddress: requestContext.identity.sourceIp,
    query: removeUndefinedFromQuery(
      event.multiValueQueryStringParameters ?? {},
    ),
    cookies:
      event.multiValueHeaders?.cookie?.reduce((acc, cur) => {
        const [key, value] = cur.split("=");
        return { ...acc, [key]: value };
      }, {}) ?? {},
  };
}

function convertFromAPIGatewayProxyEventV2(
  event: APIGatewayProxyEventV2,
): InternalEvent {
  const { rawPath, rawQueryString, requestContext } = event;
  return {
    type: "v2",
    method: requestContext.http.method,
    rawPath,
    url: rawPath + (rawQueryString ? `?${rawQueryString}` : ""),
    body: normalizeAPIGatewayProxyEventV2Body(event),
    headers: normalizeAPIGatewayProxyEventV2Headers(event),
    remoteAddress: requestContext.http.sourceIp,
    query: removeUndefinedFromQuery(convertToQuery(rawQueryString)),
    cookies:
      event.cookies?.reduce((acc, cur) => {
        const [key, value] = cur.split("=");
        return { ...acc, [key]: value };
      }, {}) ?? {},
  };
}

function convertFromCloudFrontRequestEvent(
  event: CloudFrontRequestEvent,
): InternalEvent {
  const { method, uri, querystring, body, headers, clientIp } =
    event.Records[0].cf.request;
  return {
    type: "cf",
    method,
    rawPath: uri,
    url: uri + (querystring ? `?${querystring}` : ""),
    body: Buffer.from(
      body?.data ?? "",
      body?.encoding === "base64" ? "base64" : "utf8",
    ),
    headers: normalizeCloudFrontRequestEventHeaders(headers),
    remoteAddress: clientIp,
    query: convertToQuery(querystring),
    cookies:
      headers.cookie?.reduce((acc, cur) => {
        const { key, value } = cur;
        return { ...acc, [key ?? ""]: value };
      }, {}) ?? {},
  };
}

function convertToApiGatewayProxyResult(
  result: InternalResult,
): APIGatewayProxyResult {
  const headers: Record<string, string> = {};
  const multiValueHeaders: Record<string, string[]> = {};
  Object.entries(result.headers).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      multiValueHeaders[key] = value;
    } else {
      if (value === null) {
        headers[key] = "";
        return;
      }
      headers[key] = value;
    }
  });

  const response: APIGatewayProxyResult = {
    statusCode: result.statusCode,
    headers,
    body: result.body,
    isBase64Encoded: result.isBase64Encoded,
    multiValueHeaders,
  };
  debug(response);
  return response;
}

function convertToApiGatewayProxyResultV2(
  result: InternalResult,
): APIGatewayProxyResultV2 {
  const headers: Record<string, string> = {};
  Object.entries(result.headers)
    .filter(([key]) => key.toLowerCase() !== "set-cookie")
    .forEach(([key, value]) => {
      if (value === null) {
        headers[key] = "";
        return;
      }
      headers[key] = Array.isArray(value) ? value.join(", ") : value.toString();
    });

  const response: APIGatewayProxyResultV2 = {
    statusCode: result.statusCode,
    headers,
    cookies: parseCookies(result.headers["set-cookie"]),
    body: result.body,
    isBase64Encoded: result.isBase64Encoded,
  };
  debug(response);
  return response;
}

const CloudFrontBlacklistedHeaders = [
  // Disallowed headers, see: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-function-restrictions-all.html#function-restrictions-disallowed-headers
  "connection",
  "expect",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "trailer",
  "upgrade",
  "x-accel-buffering",
  "x-accel-charset",
  "x-accel-limit-rate",
  "x-accel-redirect",
  /x-amz-cf-(.*)/,
  "x-amzn-auth",
  "x-amzn-cf-billing",
  "x-amzn-cf-id",
  "x-amzn-cf-xff",
  "x-amzn-errortype",
  "x-amzn-fle-profile",
  "x-amzn-header-count",
  "x-amzn-header-order",
  "x-amzn-lambda-integration-tag",
  "x-amzn-requestid",
  /x-edge-(.*)/,
  "x-cache",
  "x-forwarded-proto",
  "x-real-ip",

  // Read-only headers, see: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-function-restrictions-all.html#function-restrictions-read-only-headers
  "accept-encoding",
  "content-length",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "if-unmodified-since",
  "transfer-encoding",
  "via",
];

function convertToCloudFrontRequestResult(
  result: InternalResult,
): CloudFrontRequestResult {
  debug("result headers", result.headers);

  const headers: CloudFrontHeaders = {};
  Object.entries(result.headers)
    .filter(
      ([key]) =>
        !CloudFrontBlacklistedHeaders.some((header) =>
          typeof header === "string"
            ? header === key.toLowerCase()
            : header.test(key.toLowerCase()),
        ),
    )
    .forEach(([key, value]) => {
      if (key === "set-cookie") {
        const cookies = parseCookies(value);
        if (cookies) {
          headers[key] = cookies.map((cookie) => ({
            key,
            value: cookie,
          }));
        }
        return;
      }

      headers[key] = [
        ...(headers[key] || []),
        ...(Array.isArray(value)
          ? value.map((v) => ({ key, value: v }))
          : [{ key, value: value.toString() }]),
      ];
    });

  const response: CloudFrontRequestResult = {
    status: result.statusCode.toString(),
    statusDescription: "OK",
    headers,
    bodyEncoding: result.isBase64Encoded ? "base64" : "text",
    body: result.body,
  };
  debug(response);
  return response;
}

function normalizeAPIGatewayProxyEventV2Headers(
  event: APIGatewayProxyEventV2,
): Record<string, string> {
  const { headers: rawHeaders, cookies } = event;

  const headers: Record<string, string> = {};

  if (Array.isArray(cookies)) {
    headers["cookie"] = cookies.join("; ");
  }

  for (const [key, value] of Object.entries(rawHeaders || {})) {
    headers[key.toLowerCase()] = value!;
  }

  return headers;
}

function normalizeAPIGatewayProxyEventV2Body(
  event: APIGatewayProxyEventV2,
): Buffer {
  const { body, isBase64Encoded } = event;
  if (Buffer.isBuffer(body)) {
    return body;
  } else if (typeof body === "string") {
    return Buffer.from(body, isBase64Encoded ? "base64" : "utf8");
  } else if (typeof body === "object") {
    return Buffer.from(JSON.stringify(body));
  }
  return Buffer.from("", "utf8");
}

function normalizeAPIGatewayProxyEventQueryParams(
  event: APIGatewayProxyEvent,
): string {
  // Note that the same query string values are returned in both
  // "multiValueQueryStringParameters" and "queryStringParameters".
  // We only need to use one of them.
  // For example:
  //   "?name=foo" appears in the event object as
  //   {
  //     ...
  //     queryStringParameters: { name: 'foo' },
  //     multiValueQueryStringParameters: { name: [ 'foo' ] },
  //     ...
  //   }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(
    event.multiValueQueryStringParameters || {},
  )) {
    if (value !== undefined) {
      for (const v of value) {
        params.append(key, v);
      }
    }
  }
  const value = params.toString();
  return value ? `?${value}` : "";
}

function normalizeAPIGatewayProxyEventHeaders(
  event: APIGatewayProxyEvent,
): Record<string, string> {
  event.multiValueHeaders;
  const headers: Record<string, string> = {};

  for (const [key, values] of Object.entries(event.multiValueHeaders || {})) {
    if (values) {
      headers[key.toLowerCase()] = values.join(",");
    }
  }
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (value) {
      headers[key.toLowerCase()] = value;
    }
  }
  return headers;
}

function normalizeCloudFrontRequestEventHeaders(
  rawHeaders: CloudFrontHeaders,
): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [key, values] of Object.entries(rawHeaders)) {
    for (const { value } of values) {
      if (value) {
        headers[key.toLowerCase()] = value;
      }
    }
  }

  return headers;
}
