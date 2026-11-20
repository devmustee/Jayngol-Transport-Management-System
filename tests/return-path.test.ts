import { describe, expect, it } from "vitest";
import { returnPath } from "@/lib/return-path";

describe("where signing in returns to", () => {
  it("returns staff to the page they asked for, filters included", () => {
    expect(returnPath("/operators?status=active&q=a", "manager")).toBe("/operators?status=active&q=a");
    expect(returnPath("/cash?date=2026-11-19", "assistant_manager")).toBe("/cash?date=2026-11-19");
  });

  it("returns operators only within their portal", () => {
    expect(returnPath("/me/notifications", "operator")).toBe("/me/notifications");
    expect(returnPath("/dashboard", "operator")).toBe("/me");
  });

  it("keeps staff out of the operator portal", () => {
    expect(returnPath("/me", "owner")).toBe("/dashboard");
  });

  it("never leaves the app or loops back to sign-in", () => {
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "/login", "/login?next=/cash", "/", "", null, 42, "/x y"]) {
      expect(returnPath(bad, "manager")).toBe("/dashboard");
    }
  });
});
