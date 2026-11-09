import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { smsOutbox } from "@/db/schema";
import type { Clock } from "@/lib/clock";

export interface SmsSender {
  send(to: string, body: string): Promise<void>;
}

const MAX_ATTEMPTS = 5;

/**
 * Delivers queued messages through a provider. Until a provider account exists
 * no sender is configured, and messages wait safely in the outbox.
 */
export async function deliverSms(sender: SmsSender, clock: Clock, batch = 100) {
  const pending = await db
    .select()
    .from(smsOutbox)
    .where(eq(smsOutbox.status, "pending"))
    .orderBy(asc(smsOutbox.createdAt))
    .limit(batch);

  let sent = 0;
  for (const message of pending) {
    try {
      await sender.send(message.toPhone, message.body);
      await db
        .update(smsOutbox)
        .set({ status: "sent", sentAt: clock(), attempts: message.attempts + 1, lastError: null })
        .where(eq(smsOutbox.id, message.id));
      sent++;
    } catch (error) {
      const attempts = message.attempts + 1;
      await db
        .update(smsOutbox)
        .set({
          attempts,
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          lastError: error instanceof Error ? error.message : String(error),
        })
        .where(eq(smsOutbox.id, message.id));
    }
  }
  return sent;
}
