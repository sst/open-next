import { NextConfig } from "@opennextjs/aws/adapters/config/index.js";
import {
  fixDataPage,
  getNextConfigHeaders,
  handleRedirects,
  handleRewrites,
} from "@opennextjs/aws/core/routing/matcher.js";
import { convertFromQueryString } from "@opennextjs/aws/core/routing/util.js";
import type { RouteHas } from "@opennextjs/aws/types/next-types.js";
import type { InternalEvent } from "@opennextjs/aws/types/open-next.js";
import { vi } from "vitest";

vi.mock("@opennextjs/aws/adapters/config/index.js", () => ({
  NextConfig: {},
  AppPathRoutesManifest: {
    "/api/app/route": "/api/app",
    "/app/page": "/app",
    "/catchAll/[...slug]/page": "/catchAll/[...slug]",
  },
  RoutesManifest: {
    version: 3,
    pages404: true,
    caseSensitive: false,
    basePath: "",
    locales: [],
    redirects: [],
    headers: [],
    routes: {
      dynamic: [
        {
          page: "/catchAll/[...slug]",
          regex: "^/catchAll/(.+?)(?:/)?$",
          routeKeys: {
            nxtPslug: "nxtPslug",
          },
          namedRegex: "^/catchAll/(?<nxtPslug>.+?)(?:/)?$",
        },
        {
          page: "/page/catchAll/[...slug]",
          regex: "^/page/catchAll/(.+?)(?:/)?$",
          routeKeys: {
            nxtPslug: "nxtPslug",
          },
          namedRegex: "^/page/catchAll/(?<nxtPslug>.+?)(?:/)?$",
        },
      ],
      static: [
        {
          page: "/app",
          regex: "^/app(?:/)?$",
          routeKeys: {},
          namedRegex: "^/app(?:/)?$",
        },
        {
          page: "/page",
          regex: "^/page(?:/)?$",
          routeKeys: {},
          namedRegex: "^/page(?:/)?$",
        },
        {
          page: "/page/catchAll/static",
          regex: "^/page/catchAll/static(?:/)?$",
          routeKeys: {},
          namedRegex: "^/page/catchAll/static(?:/)?$",
        },
      ],
    },
  },
  PagesManifest: {
    "/_app": "pages/_app.js",
    "/_document": "pages/_document.js",
    "/_error": "pages/_error.js",
    "/404": "pages/404.html",
  },
}));

vi.mock("@opennextjs/aws/core/routing/i18n/index.js", () => ({
  localizePath: (event: InternalEvent) => event.rawPath,
  handleLocaleRedirect: (_event: InternalEvent) => false,
}));

type PartialEvent = Partial<
  Omit<InternalEvent, "body" | "rawPath" | "query">
> & { body?: string };

function createEvent(event: PartialEvent): InternalEvent {
  const url = event.url ?? "https://on/";
  const { pathname, search } = new URL(url);
  return {
    type: "core",
    method: event.method ?? "GET",
    rawPath: pathname,
    url: event.url ?? "/",
    body: Buffer.from(event.body ?? ""),
    headers: event.headers ?? {},
    query: convertFromQueryString(search.slice(1)),
    cookies: event.cookies ?? {},
    remoteAddress: event.remoteAddress ?? "::1",
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("getNextConfigHeaders", () => {
  it("should return empty object for undefined configHeaders", () => {
    const event = createEvent({});
    const result = getNextConfigHeaders(event);

    expect(result).toEqual({});
  });

  it("should return empty object for empty configHeaders", () => {
    const event = createEvent({});
    const result = getNextConfigHeaders(event, []);

    expect(result).toEqual({});
  });

  it("should return request headers for matching / route", () => {
    const event = createEvent({
      url: "https://on/",
    });

    const result = getNextConfigHeaders(event, [
      {
        source: "/",
        regex: "^/$",
        headers: [
          {
            key: "foo",
            value: "bar",
          },
        ],
      },
    ]);

    expect(result).toEqual({
      foo: "bar",
    });
  });

  it("should return empty request headers for matching / route with empty headers", () => {
    const event = createEvent({
      url: "https://on/",
    });

    const result = getNextConfigHeaders(event, [
      {
        source: "/",
        regex: "^/$",
        headers: [],
      },
    ]);

    expect(result).toEqual({});
  });

  it("should return request headers for matching /* route", () => {
    const event = createEvent({
      url: "https://on/hello-world",
    });

    const result = getNextConfigHeaders(event, [
      {
        source: "/(.*)",
        regex: "^(?:/(.*))(?:/)?$",
        headers: [
          {
            key: "foo",
            value: "bar",
          },
          {
            key: "hello",
            value: "world",
          },
        ],
      },
    ]);

    expect(result).toEqual({
      foo: "bar",
      hello: "world",
    });
  });

  it("should return request headers for matching /* route with has condition", () => {
    const event = createEvent({
      url: "https://on/hello-world",
      cookies: {
        match: "true",
      },
    });

    const result = getNextConfigHeaders(event, [
      {
        source: "/(.*)",
        regex: "^(?:/(.*))(?:/)?$",
        headers: [
          {
            key: "foo",
            value: "bar",
          },
        ],
        has: [{ type: "cookie", key: "match" }],
      },
    ]);

    expect(result).toEqual({
      foo: "bar",
    });
  });

  it.each([
    {
      name: "header",
      event: { headers: { "x-forwarded-proto": "https" } },
      has: {
        type: "header",
        key: "x-forwarded-proto",
        value: "http",
      },
    },
    {
      name: "cookie",
      event: { cookies: { protocol: "https" } },
      has: { type: "cookie", key: "protocol", value: "http" },
    },
    {
      name: "query",
      event: { url: "https://on/hello-world?protocol=https" },
      has: { type: "query", key: "protocol", value: "http" },
    },
    {
      name: "host",
      event: { headers: { host: "not-on.example" } },
      has: { type: "host", value: "on.example" },
    },
  ] satisfies {
    name: string;
    event: PartialEvent;
    has: RouteHas;
  }[])("should require an exact $name value match", ({ event, has }) => {
    const result = getNextConfigHeaders(createEvent(event), [
      {
        source: "/(.*)",
        regex: "^(?:/(.*))(?:/)?$",
        headers: [{ key: "foo", value: "bar" }],
        has: [has],
      },
    ]);

    expect(result).toEqual({});
  });

  it("should not match an absent value-less query condition", () => {
    const event = createEvent({
      url: "https://on/hello-world",
    });

    const result = getNextConfigHeaders(event, [
      {
        source: "/(.*)",
        regex: "^(?:/(.*))(?:/)?$",
        headers: [{ key: "x-robots-tag", value: "noindex" }],
        has: [{ type: "query", key: "preview" }],
      },
    ]);

    expect(result).toEqual({});
  });

  it("should match a present value-less query condition", () => {
    const event = createEvent({
      url: "https://on/hello-world?preview=1",
    });

    const result = getNextConfigHeaders(event, [
      {
        source: "/(.*)",
        regex: "^(?:/(.*))(?:/)?$",
        headers: [{ key: "x-robots-tag", value: "noindex" }],
        has: [{ type: "query", key: "preview" }],
      },
    ]);

    expect(result).toEqual({ "x-robots-tag": "noindex" });
  });

  it("should return request headers for matching /* route with missing condition", () => {
    const event = createEvent({
      url: "https://on/hello-world",
      cookies: {
        match: "true",
      },
    });

    const result = getNextConfigHeaders(event, [
      {
        source: "/(.*)",
        regex: "^(?:/(.*))(?:/)?$",
        headers: [
          {
            key: "foo",
            value: "bar",
          },
        ],
        missing: [{ type: "cookie", key: "missing" }],
      },
    ]);

    expect(result).toEqual({
      foo: "bar",
    });
  });

  it("should return request headers for matching /* route with has and missing condition", () => {
    const event = createEvent({
      url: "https://on/hello-world",
      cookies: {
        match: "true",
      },
    });

    const result = getNextConfigHeaders(event, [
      {
        source: "/(.*)",
        regex: "^(?:/(.*))(?:/)?$",
        headers: [
          {
            key: "foo",
            value: "bar",
          },
        ],
        has: [{ type: "cookie", key: "match" }],
        missing: [{ type: "cookie", key: "missing" }],
      },
    ]);

    expect(result).toEqual({
      foo: "bar",
    });
  });

  it.todo(
    "should exercise the error scenario: 'Error matching header <key> with value <value>'",
  );
});

describe("handleRedirects", () => {
  it("should redirect repeated slashes", () => {
    const event = createEvent({
      url: "https://on/api-route//foo",
    });

    const result = handleRedirects(event, []);

    expect(result.statusCode).toEqual(308);
    expect(result.headers.Location).toEqual("https://on/api-route/foo");
  });

  it("should redirect trailing slash by default", () => {
    const event = createEvent({
      url: "https://on/api-route/",
    });

    const result = handleRedirects(event, []);

    expect(result.statusCode).toEqual(308);
    expect(result.headers.Location).toEqual("https://on/api-route");
  });

  it("should not redirect trailing slash when skipTrailingSlashRedirect is true", () => {
    const event = createEvent({
      url: "https://on/api-route/",
    });

    NextConfig.skipTrailingSlashRedirect = true;
    const result = handleRedirects(event, []);

    expect(result).toBeUndefined();
  });

  it("should redirect matching path", () => {
    const event = createEvent({
      url: "https://on/api-route",
    });

    const result = handleRedirects(event, [
      {
        source: "/:path+",
        destination: "/new/:path+",
        locale: false,
        statusCode: 308,
        regex: "^(?!/_next)(?:/((?:[^/]+?)(?:/(?:[^/]+?))*))(?:/)?$",
      },
    ]);

    expect(result.headers.Location).toBe("https://on/new/api-route");
  });

  it("should redirect matching nested path", () => {
    const event = createEvent({
      url: "https://on/api-route/secret",
    });

    const result = handleRedirects(event, [
      {
        source: "/:path+",
        destination: "/new/:path+",
        locale: false,
        statusCode: 308,
        regex: "^(?!/_next)(?:/((?:[^/]+?)(?:/(?:[^/]+?))*))(?:/)?$",
      },
    ]);

    expect(result.headers.Location).toBe("https://on/new/api-route/secret");
  });

  it("should not redirect unmatched path", () => {
    const event = createEvent({
      url: "https://on/api-route",
    });

    const result = handleRedirects(event, [
      {
        source: "/foo/",
        destination: "/bar",
        locale: false,
        statusCode: 307,
        regex: "^(?!/_next)/foo/(?:/)?$",
      },
    ]);

    expect(result).toBeUndefined();
  });

  it("should redirect with + character and query string", () => {
    const event = createEvent({
      url: "https://on/foo",
    });

    const result = handleRedirects(event, [
      {
        source: "/foo",
        destination: "/search?bar=hello+world&baz=new%2C+earth",
        locale: false,
        statusCode: 308,
        regex: "^(?!/_next)/foo(?:/)?$",
      },
    ]);

    expect(result.statusCode).toEqual(308);
    expect(result.headers.Location).toEqual(
      "https://on/search?bar=hello+world&baz=new%2C+earth",
    );
  });

  // For reference https://github.com/opennextjs/opennextjs-aws/issues/1217
  it("should redirect to the root with a query string", () => {
    const event = createEvent({
      url: "https://on/promo/anything",
    });

    const result = handleRedirects(event, [
      {
        source: "/promo/:path*",
        destination: "/?ref=promo",
        locale: false,
        statusCode: 308,
        regex: "^(?!/_next)/promo(?:/((?:[^/]+?)(?:/(?:[^/]+?))*))?(?:/)?$",
      },
    ]);

    expect(result.statusCode).toEqual(308);
    expect(result.headers.Location).toEqual("https://on/?ref=promo");
  });
});

describe("handleRewrites", () => {
  it("should not rewrite with empty rewrites", () => {
    const event = createEvent({
      url: "https://on/foo?hello=world",
    });

    const result = handleRewrites(event, []);

    expect(result).toEqual({
      internalEvent: event,
      isExternalRewrite: false,
    });
  });

  it("should rewrite with params", () => {
    const event = createEvent({
      url: "https://on/albums/foo/bar",
    });

    const rewrites = [
      {
        source: "/albums/:album",
        destination: "/rewrite/albums/:album",
        regex: "^/albums(?:/([^/]+?))(?:/)?$",
      },
      {
        source: "/albums/:album/:song",
        destination: "/rewrite/albums/:album/:song",
        regex: "^/albums(?:/([^/]+?))(?:/([^/]+?))(?:/)?$",
      },
    ];
    const result = handleRewrites(event, rewrites);

    expect(result).toEqual({
      internalEvent: {
        ...event,
        rawPath: "/rewrite/albums/foo/bar",
        url: "https://on/rewrite/albums/foo/bar",
      },
      __rewrite: rewrites[1],
      isExternalRewrite: false,
    });
  });

  it("should rewrite without params", () => {
    const event = createEvent({
      url: "https://on/foo",
    });

    const rewrites = [
      {
        source: "foo",
        destination: "/bar",
        regex: "^/foo(?:/)?$",
      },
    ];
    const result = handleRewrites(event, rewrites);

    expect(result).toEqual({
      internalEvent: {
        ...event,
        rawPath: "/bar",
        url: "https://on/bar",
      },
      __rewrite: rewrites[0],
      isExternalRewrite: false,
    });
  });

  it("should rewrite externally", () => {
    const event = createEvent({
      url: "https://on/albums/foo/bar",
    });

    const rewrites = [
      {
        source: "/albums/:album/:song",
        destination: "https://external.com/search?album=:album&song=:song",
        regex: "^/albums(?:/([^/]+?))(?:/([^/]+?))(?:/)?$",
      },
    ];
    const result = handleRewrites(event, rewrites);

    expect(result).toEqual({
      internalEvent: {
        ...event,
        query: {
          album: "foo",
          song: "bar",
        },
        rawPath: "/search",
        url: "https://external.com/search?album=foo&song=bar",
      },
      __rewrite: rewrites[0],
      isExternalRewrite: true,
    });
  });

  // For reference https://github.com/opennextjs/opennextjs-aws/issues/1217
  it("should rewrite to the root with a query string", () => {
    const event = createEvent({
      url: "https://on/promo/anything",
    });

    const rewrites = [
      {
        source: "/promo/:path*",
        destination: "/?ref=promo",
        regex: "^/promo(?:/((?:[^/]+?)(?:/(?:[^/]+?))*))?(?:/)?$",
      },
    ];
    const result = handleRewrites(event, rewrites);

    expect(result).toEqual({
      internalEvent: {
        ...event,
        query: { ref: "promo" },
        rawPath: "/",
        url: "https://on/?ref=promo",
      },
      __rewrite: rewrites[0],
      isExternalRewrite: false,
    });
  });

  // For reference https://github.com/opennextjs/opennextjs-aws/issues/1217
  it("should rewrite externally to a query string without a path", () => {
    const event = createEvent({
      url: "https://on/albums/foo",
    });

    const rewrites = [
      {
        source: "/albums/:album",
        destination: "https://external.com?album=:album",
        regex: "^/albums(?:/([^/]+?))(?:/)?$",
      },
    ];
    const result = handleRewrites(event, rewrites);

    expect(result).toEqual({
      internalEvent: {
        ...event,
        query: { album: "foo" },
        rawPath: "/",
        url: "https://external.com?album=foo",
      },
      __rewrite: rewrites[0],
      isExternalRewrite: true,
    });
  });

  it("should rewrite with matching path with has condition", () => {
    const event = createEvent({
      url: "https://on/albums/foo?has=true",
    });

    const rewrites = [
      {
        source: "/albums/:album",
        destination: "/rewrite/albums/:album",
        regex: "^/albums(?:/([^/]+?))(?:/)?$",
        has: [
          {
            type: "query",
            key: "has",
            value: "true",
          },
        ],
      },
    ];
    const result = handleRewrites(event, rewrites);

    expect(result).toEqual({
      internalEvent: {
        ...event,
        rawPath: "/rewrite/albums/foo",
        url: "https://on/rewrite/albums/foo?has=true",
      },
      __rewrite: rewrites[0],
      isExternalRewrite: false,
    });
  });

  it("should rewrite with matching path with missing condition", () => {
    const event = createEvent({
      url: "https://on/albums/foo",
      headers: {
        has: "true",
      },
    });

    const rewrites = [
      {
        source: "/albums/:album",
        destination: "/rewrite/albums/:album",
        regex: "^/albums(?:/([^/]+?))(?:/)?$",
        missing: [
          {
            type: "header",
            key: "missing",
          },
        ],
      },
    ];
    const result = handleRewrites(event, rewrites);

    expect(result).toEqual({
      internalEvent: {
        ...event,
        rawPath: "/rewrite/albums/foo",
        url: "https://on/rewrite/albums/foo",
      },
      __rewrite: rewrites[0],
      isExternalRewrite: false,
    });
  });
});

describe("fixDataPage", () => {
  it("should return 404 for data requests that don't match the buildId", () => {
    const event = createEvent({
      url: "https://on/_next/data/xyz/test",
    });

    const response = fixDataPage(event, "abc");

    expect(response.statusCode).toEqual(404);
  });

  it("should not return 404 for data requests that don't match the buildId", () => {
    const event = createEvent({
      url: "https://on/_next/data/abc/test",
    });

    const response = fixDataPage(event, "abc");

    expect(response.statusCode).not.toEqual(404);
    expect(response).toEqual(event);
  });

  it("should not return 404 for data requests (with base path) that don't match the buildId", () => {
    NextConfig.basePath = "/base";

    const event = createEvent({
      url: "https://on/base/_next/data/abc/test",
    });

    const response = fixDataPage(event, "abc");

    expect(response.statusCode).not.toEqual(404);
    expect(response).toEqual(event);

    NextConfig.basePath = undefined;
  });

  it("should remove json extension from data requests and add __nextDataReq to query", () => {
    const event = createEvent({
      url: "https://on/_next/data/abc/test/file.json?hello=world",
    });

    const response = fixDataPage(event, "abc");

    expect(response).toEqual({
      ...event,
      rawPath: "/test/file",
      url: "https://on/test/file?hello=world&__nextDataReq=1",
      headers: { "x-nextjs-data": "1" },
    });
  });

  it("should remove json extension from data requests (with base path) and add __nextDataReq to query", () => {
    const mockBasePath = "/base";
    NextConfig.basePath = mockBasePath;

    const event = createEvent({
      url: `https://on${mockBasePath}/_next/data/abc/test/file.json?hello=world`,
    });

    const response = fixDataPage(event, "abc");

    expect(response).toEqual({
      ...event,
      rawPath: `${mockBasePath}/test/file`,
      url: `https://on${mockBasePath}/test/file?hello=world&__nextDataReq=1`,
      headers: { "x-nextjs-data": "1" },
    });

    NextConfig.basePath = undefined;
  });
});
