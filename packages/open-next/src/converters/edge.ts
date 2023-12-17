import { parseCookies } from "http/util";
import { Converter, InternalEvent, InternalResult } from "types/open-next";

import { MiddlewareOutputEvent } from "../core/routingHandler";

const converter: Converter<
  InternalEvent,
  InternalResult | ({ type: "middleware" } & MiddlewareOutputEvent)
> = {
  convertFrom: async (event: Request) => {
    const searchParams = new URL(event.url).searchParams;
    const query: Record<string, string | string[]> = {};
    for (const [key, value] of searchParams.entries()) {
      if (query[key]) {
        if (Array.isArray(query[key])) {
          (query[key] as string[]).push(value);
        } else {
          query[key] = [query[key] as string, value];
        }
      } else {
        query[key] = value;
      }
    }
    //Transform body into Buffer
    const body = await event.arrayBuffer();
    const headers: Record<string, string> = {};
    event.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const rawPath = new URL(event.url).pathname;

    return {
      type: "core",
      method: event.method,
      rawPath,
      url: event.url,
      body: event.method !== "GET" ? Buffer.from(body) : undefined,
      headers: headers,
      remoteAddress: (event.headers.get("x-forwarded-for") as string) ?? "::1",
      query,
      cookies: Object.fromEntries(
        parseCookies(event.headers.get("cookie") ?? "")?.map((cookie) => {
          const [key, value] = cookie.split("=");
          return [key, value];
        }) ?? [],
      ),
    };
  },
  convertTo: async (result) => {
    if ("internalEvent" in result) {
      const url = result.isExternalRewrite
        ? result.internalEvent.url
        : `https://${result.internalEvent.headers.host}${result.internalEvent.url}`;
      const req = new Request(url, {
        body: result.internalEvent.body,
        method: result.internalEvent.method,
        headers: result.internalEvent.headers,
      });
      return fetch(req);
    } else {
      const headers = new Headers();
      for (const [key, value] of Object.entries(result.headers)) {
        headers.set(key, Array.isArray(value) ? value.join(",") : value);
      }
      return new Response(result.body, {
        status: result.statusCode,
        headers: headers,
      });
    }
  },
};

export default converter;
