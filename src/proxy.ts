import { NextResponse, type NextRequest } from "next/server";
import { PATH_HEADER } from "@/lib/return-path";

/**
 * Passes the requested address on to the page. Nothing is decided here: the
 * page itself checks the session, and only uses this to remember where to
 * return after signing in.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(PATH_HEADER, request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Pages only: not files, the API or Next's own assets.
  matcher: ["/((?!api/|_next/|brand/|.*\\.[a-z0-9]+$).*)"],
};
