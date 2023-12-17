import http from "node:http";

export const parseHeaders = (
  headers?: http.OutgoingHttpHeader[] | http.OutgoingHttpHeaders,
) => {
  const result: Record<string, string> = {};
  if (!headers) {
    return result;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    } else {
      result[key] = convertHeader(value);
    }
  }

  return result;
};

export const convertHeader = (header: http.OutgoingHttpHeader) => {
  if (typeof header === "string") {
    return header;
  } else if (Array.isArray(header)) {
    return header.join(",");
  } else {
    return String(header);
  }
};

export function parseCookies(
  cookies?: string | string[],
): string[] | undefined {
  if (!cookies) return;

  if (typeof cookies === "string") {
    return cookies.split(/(?<!Expires=\w+),/i).map((c) => c.trim());
  }

  return cookies;
}
