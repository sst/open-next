import {
  CloudFrontCustomOrigin,
  CloudFrontHeaders,
  CloudFrontRequest,
  CloudFrontRequestEvent,
  CloudFrontRequestResult,
} from "aws-lambda";
import { OutgoingHttpHeader } from "http";
import type { Converter, InternalEvent, InternalResult } from "types/open-next";

import { debug } from "../adapters/logger";
import {
  convertRes,
  convertToQuery,
  convertToQueryString,
  createServerResponse,
  proxyRequest,
} from "../core/routing/util";
import { MiddlewareOutputEvent } from "../core/routingHandler";

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

async function convertFromCloudFrontRequestEvent(
  event: CloudFrontRequestEvent,
): Promise<InternalEvent> {
  const { method, uri, querystring, body, headers, clientIp } =
    event.Records[0].cf.request;
  return {
    type: "core",
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

type MiddlewareEvent = {
  type: "middleware";
} & MiddlewareOutputEvent;

function convertToCloudfrontHeaders(
  headers: Record<string, OutgoingHttpHeader>,
) {
  const cloudfrontHeaders: CloudFrontHeaders = {};
  Object.entries(headers)
    .filter(([key]) => key.toLowerCase() !== "content-length")
    .forEach(([key, value]) => {
      cloudfrontHeaders[key] = [
        ...(cloudfrontHeaders[key] || []),
        ...(Array.isArray(value)
          ? value.map((v) => ({ key, value: v }))
          : [{ key, value: value.toString() }]),
      ];
    });
  return cloudfrontHeaders;
}

async function convertToCloudFrontRequestResult(
  result: InternalResult | MiddlewareEvent,
  originalRequest: CloudFrontRequestEvent,
): Promise<CloudFrontRequestResult> {
  let responseHeaders =
    result.type === "middleware"
      ? result.internalEvent.headers
      : result.headers;
  if (result.type === "middleware") {
    const { method, clientIp, origin } = originalRequest.Records[0].cf.request;
    const overwrittenResponseHeaders: Record<string, OutgoingHttpHeader> = {};
    Object.entries(result.headers).forEach(([key, value]) => {
      //TODO: handle those headers inside plugin
      if (value)
        overwrittenResponseHeaders[`x-middleware-response-${key}`] = value;
    });

    // Handle external rewrite
    if (result.isExternalRewrite) {
      const serverResponse = createServerResponse(result.internalEvent, {});
      await proxyRequest(result.internalEvent, serverResponse);
      const externalResult = convertRes(serverResponse);
      debug("externalResult", {
        status: externalResult.statusCode.toString(),
        statusDescription: "OK",
        headers: convertToCloudfrontHeaders(externalResult.headers),
        bodyEncoding: externalResult.isBase64Encoded ? "base64" : "text",
        body: externalResult.body,
      });
      return {
        status: externalResult.statusCode.toString(),
        statusDescription: "OK",
        headers: convertToCloudfrontHeaders(externalResult.headers),
        bodyEncoding: externalResult.isBase64Encoded ? "base64" : "text",
        body: externalResult.body,
      };
    }
    let customOrigin = origin?.custom as CloudFrontCustomOrigin;
    let host = responseHeaders["host"] ?? responseHeaders["Host"];
    if (result.origin) {
      customOrigin = {
        ...customOrigin,
        domainName: result.origin.host,
        port: result.origin.port ?? 443,
        protocol: result.origin.protocol ?? "https",
        customHeaders: {},
      };
      host = result.origin.host;
    }

    const response: CloudFrontRequest = {
      clientIp,
      method,
      uri: result.internalEvent.rawPath,
      querystring: convertToQueryString(result.internalEvent.query).replace(
        "?",
        "",
      ),
      headers: convertToCloudfrontHeaders({
        ...responseHeaders,
        ...overwrittenResponseHeaders,
        host,
      }),
      origin: origin?.custom
        ? {
            custom: customOrigin,
          }
        : origin,
    };

    debug("response rewrite", response);

    return response;
  }

  const response: CloudFrontRequestResult = {
    status: result.statusCode.toString(),
    statusDescription: "OK",
    headers: convertToCloudfrontHeaders(responseHeaders),
    bodyEncoding: result.isBase64Encoded ? "base64" : "text",
    body: result.body,
  };
  debug(response);
  return response;
}

export default {
  convertFrom: convertFromCloudFrontRequestEvent,
  convertTo: convertToCloudFrontRequestResult,
} as Converter;
