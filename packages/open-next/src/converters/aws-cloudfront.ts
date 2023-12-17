import {
  CloudFrontHeaders,
  CloudFrontRequestEvent,
  CloudFrontRequestResult,
} from "aws-lambda";
import type { Converter, InternalEvent, InternalResult } from "types/open-next";

import { debug } from "../adapters/logger";
import { convertToQuery } from "../core/routing/util";

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

function convertToCloudFrontRequestResult(
  result: InternalResult,
): CloudFrontRequestResult {
  const headers: CloudFrontHeaders = {};
  Object.entries(result.headers)
    .filter(([key]) => key.toLowerCase() !== "content-length")
    .forEach(([key, value]) => {
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

export default {
  convertFrom: convertFromCloudFrontRequestEvent,
  convertTo: convertToCloudFrontRequestResult,
} as Converter;
