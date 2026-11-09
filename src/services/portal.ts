import { getMyAwardProgress } from "./awards";
import type { Ctx } from "./context";
import { getMyStatement } from "./finance";
import { getMyPortal } from "./operators";
import { getMyCompliance } from "./violations";
import { getMyService } from "./workshop";

/**
 * Everything the operator portal shows. Each part takes the operator from the
 * login session, and nothing here accepts an operator ID.
 */
export async function getMyRecords(ctx: Ctx) {
  const [portal, statement, compliance, service, awards] = await Promise.all([
    getMyPortal(ctx),
    getMyStatement(ctx),
    getMyCompliance(ctx),
    getMyService(ctx),
    getMyAwardProgress(ctx),
  ]);
  return { ...portal, statement, compliance, service, awards };
}
