import { describe, expect, it } from "vitest";
import { isConnectError, retryConnect } from "@/db/retry";

describe("trying again when the database cannot be reached", () => {
  it("knows connection failures, even wrapped, from other errors", () => {
    expect(isConnectError(Object.assign(new Error("x"), { code: "CONNECT_TIMEOUT" }))).toBe(true);
    expect(isConnectError(new Error("Failed query", { cause: new Error("(EMAXCONNSESSION) max clients reached in session mode") }))).toBe(true);
    expect(isConnectError(Object.assign(new Error("duplicate key"), { code: "23505" }))).toBe(false);
    expect(isConnectError(undefined)).toBe(false);
  });

  it("tries twice more, then gives up", async () => {
    let calls = 0;
    const busy = () => {
      calls++;
      return Promise.reject(Object.assign(new Error("busy"), { code: "ECONNREFUSED" }));
    };
    await expect(retryConnect(busy)).rejects.toThrow("busy");
    expect(calls).toBe(3);
  });

  it("returns as soon as one try works, and never repeats other errors", async () => {
    let calls = 0;
    expect(
      await retryConnect(async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("x"), { code: "ETIMEDOUT" });
        return "ok";
      }),
    ).toBe("ok");
    calls = 0;
    await expect(retryConnect(async () => { calls++; throw new Error("bad input"); })).rejects.toThrow("bad input");
    expect(calls).toBe(1);
  });
});
