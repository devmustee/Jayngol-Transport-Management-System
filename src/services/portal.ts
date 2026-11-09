import { getHonourBoard, getMyAwardJourney, getMyRunAtRisk } from "./award-tracker";
import type { Ctx } from "./context";
import { getMyDeposits } from "./deposits";
import { getMyStatement } from "./finance";
import { getMyNotices } from "./notices";
import { getMyPortal } from "./operators";
import { getMyCompliance } from "./violations";
import { getMyService } from "./workshop";

/**
 * Everything the operator portal shows. Each part takes the operator from the
 * login session, and nothing here accepts an operator ID.
 */
export async function getMyRecords(ctx: Ctx) {
  const [portal, statement, compliance, service, journey, honourBoard, runAtRisk, notices, deposits] = await Promise.all([
    getMyPortal(ctx),
    getMyStatement(ctx),
    getMyCompliance(ctx),
    getMyService(ctx),
    getMyAwardJourney(ctx),
    getHonourBoard(ctx),
    getMyRunAtRisk(ctx),
    getMyNotices(ctx),
    getMyDeposits(ctx),
  ]);
  return { ...portal, statement, compliance, service, journey, honourBoard, runAtRisk, notices, deposits };
}
