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
    u.searchParams.set("a", "b");
    return NextResponse.rewrite(u);
  } else if (path === "/api/middleware") {
    return new NextResponse(JSON.stringify({ hello: "middleware" }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  } else {
    const rHeaders = new Headers(request.headers);
    const r = NextResponse.next({
      request: {
        headers: rHeaders,
      },
    });
    return r;
  }
}

export const config = {
  matcher: ["/((?!_next|favicon.ico|match|static|fonts|api/auth|og).*)"],
};
