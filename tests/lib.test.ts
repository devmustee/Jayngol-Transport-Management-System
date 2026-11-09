import { describe, expect, it } from "vitest";
import { businessDate } from "@/lib/clock";
import { formatNaira, parseNairaToKobo } from "@/lib/money";
import { formatPhone, normalizePhone } from "@/lib/phone";

describe("business date", () => {
  it("rolls over at midnight in Lagos, not UTC", () => {
    expect(businessDate(new Date("2026-11-09T22:59:59Z"))).toBe("2026-11-09");
    expect(businessDate(new Date("2026-11-09T23:00:00Z"))).toBe("2026-11-10");
  });
});

describe("money", () => {
  it.each([
    ["12000", 1_200_000],
    ["12,000", 1_200_000],
    ["₦15,000.50", 1_500_050],
    ["0.1", 10],
    ["19.99", 1999],
  ])("parses %s without floating-point error", (input, kobo) => {
    expect(parseNairaToKobo(input)).toBe(kobo);
  });

  it.each(["", "abc", "12.345", "-5", "1e5"])("rejects %s", (input) => {
    expect(parseNairaToKobo(input)).toBeNull();
  });

  it("formats kobo as naira", () => {
    expect(formatNaira(1_200_000)).toBe("₦12,000");
    expect(formatNaira(1_500_050)).toBe("₦15,000.50");
  });
});

describe("phone numbers", () => {
  it.each(["08031234567", "0803 123 4567", "+2348031234567", "2348031234567", "8031234567"])(
    "normalises %s",
    (input) => expect(normalizePhone(input)).toBe("+2348031234567"),
  );

  it.each(["", "12345", "05031234567", "0803123456", "phone"])("rejects %s", (input) => {
    expect(normalizePhone(input)).toBeNull();
  });

  it("formats for display", () => {
    expect(formatPhone("+2348031234567")).toBe("0803 123 4567");
  });
});
