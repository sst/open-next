import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname; //new URL(request.url).pathname;

  const host = request.headers.get("host");
  const protocol = host?.startsWith("localhost") ? "http" : "https";
  if (path === "/redirect") {
    const u = new URL("/redirect-destination", `${protocol}://${host}`);
    return NextResponse.redirect(u, {
      headers: { "set-cookie": "test=success" },
    });
  } else if (path === "/rewrite") {
    const u = new URL("/rewrite-destination", `${protocol}://${host}`);
    return NextResponse.rewrite(u);
  } else if (path === "/api/middleware") {
    return new NextResponse(JSON.stringify({ hello: "middleware" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  } else {
    const requestHeaders = new Headers();
    // Setting the Request Headers, this should be available in RSC
    requestHeaders.set("request-header", "request-header");
    requestHeaders.set(
      "search-params",
      `mw/${request.nextUrl.searchParams.get("searchParams") || ""}`,
    );
    const responseHeaders = new Headers();
    // Response headers should show up in the client's response headers
    responseHeaders.set("response-header", "response-header");

    // Set the cache control header with custom swr
    // For: isr.test.ts
    if (path === "/isr" && !request.headers.get("x-prerender-revalidate")) {
      responseHeaders.set(
        "cache-control",
        "max-age=10, stale-while-revalidate=999",
      );
    }

    // It is so that cloudfront doesn't cache the response
    if (
      path.startsWith("/revalidate-tag") ||
      path.startsWith("/revalidate-path")
    ) {
      responseHeaders.set(
        "cache-control",
        "private, no-cache, no-store, max-age=0, must-revalidate",
      );
    }

    const r = NextResponse.next({
      headers: responseHeaders,
      request: {
        headers: requestHeaders,
      },
    });

    // Set cookies in middleware
    // For: middleware.cookies.test.ts
    r.cookies.set("from", "middleware", {
      expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
    });
    r.cookies.set("with", "love", {
      expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
    });

    return r;
  }
}

export const config = {
  matcher: ["/((?!_next|favicon.ico|match|static|fonts|api/auth|og).*)"],
};
