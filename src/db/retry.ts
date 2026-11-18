/**
 * Errors where the database was never reached, so nothing ran and trying
 * again is safe: the pooler had no free connection, or the network failed
 * while connecting.
 */
const CONNECT_CODES = new Set(["CONNECT_TIMEOUT", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"]);

export function isConnectError(error: unknown): boolean {
  for (let e = error as { code?: unknown; message?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 5; depth++) {
    if (typeof e.code === "string" && CONNECT_CODES.has(e.code)) return true;
    if (typeof e.message === "string" && /max clients reached|EMAXCONN|too many clients|remaining connection slots/i.test(e.message)) {
      return true;
    }
    e = e.cause as typeof e;
  }
  return false;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a read that is safe to repeat, trying again twice when the database
 * could not be reached. Only for work that changes nothing, or that is the
 * same when done twice.
 */
export async function retryConnect<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= 2 || !isConnectError(error)) throw error;
      await wait(300 * (attempt + 1));
    }
  }
}
