/** The header that tells a page which address was asked for, so sign-in can return there. */
export const PATH_HEADER = "x-jayngol-path";

/**
 * Where to go after signing in. Only an address inside this app, never the
 * sign-in page itself, and only one the person's kind of login can open:
 * operators stay in their portal, staff stay out of it.
 */
export function returnPath(next: unknown, role: string): string {
  const home = role === "operator" ? "/me" : "/dashboard";
  if (typeof next !== "string" || next.length > 500) return home;
  if (!/^\/(?![/\\])[^\s\\\u0000-\u001f\u007f]*$/.test(next)) return home;
  const path = next.split(/[?#]/)[0]!;
  if (path === "/" || path === "/login" || path.startsWith("/login/")) return home;
  const portal = path === "/me" || path.startsWith("/me/");
  if (role === "operator" ? !portal : portal) return home;
  return next;
}
