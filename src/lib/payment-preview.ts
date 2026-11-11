/**
 * What a payment will clear, worked out before it is saved. It follows the same
 * rule as recordPayment: the stated fines part goes to fines, the stated loan
 * part to the loan, and everything else to unpaid balances, oldest day first.
 * Whatever is left after that is kept as credit for the next balance.
 */

export type OpenBalance = { businessDate: string; outstandingKobo: number };

export type PaymentPreview = {
  finesKobo: number;
  loanKobo: number;
  /** Each balance day this payment touches, oldest first. */
  days: { businessDate: string; appliedKobo: number; cleared: boolean }[];
  balancesKobo: number;
  creditKobo: number;
  balanceLeftKobo: number;
  loanLeftKobo: number;
  /** Problems the server would refuse, so staff can fix them before saving. */
  problems: string[];
};

export function previewPayment(input: {
  amountKobo: number;
  finesPartKobo: number;
  loanPartKobo: number;
  balances: OpenBalance[];
  finesOwedKobo: number;
  loanOwedKobo: number;
}): PaymentPreview {
  const { amountKobo, finesPartKobo, loanPartKobo, balances, finesOwedKobo, loanOwedKobo } = input;
  const problems: string[] = [];
  if (finesPartKobo > finesOwedKobo) problems.push("The fines part is more than the fines owed.");
  if (loanPartKobo > loanOwedKobo) problems.push("The loan part is more than the loan owed.");
  if (finesPartKobo + loanPartKobo > amountKobo) {
    problems.push("Fines and loan together are more than the amount received.");
  }

  let remaining = Math.max(0, amountKobo - finesPartKobo - loanPartKobo);
  const days: PaymentPreview["days"] = [];
  for (const day of balances) {
    if (remaining <= 0) break;
    if (day.outstandingKobo <= 0) continue;
    const applied = Math.min(remaining, day.outstandingKobo);
    days.push({ businessDate: day.businessDate, appliedKobo: applied, cleared: applied === day.outstandingKobo });
    remaining -= applied;
  }
  const balancesKobo = days.reduce((sum, d) => sum + d.appliedKobo, 0);
  const owed = balances.reduce((sum, d) => sum + Math.max(0, d.outstandingKobo), 0);
  return {
    finesKobo: finesPartKobo,
    loanKobo: loanPartKobo,
    days,
    balancesKobo,
    creditKobo: remaining,
    balanceLeftKobo: owed - balancesKobo,
    loanLeftKobo: Math.max(0, loanOwedKobo - loanPartKobo),
    problems,
  };
}

/** Kobo as the plain number typed into an amount box, such as "15000" or "15000.50". */
export function koboToInput(kobo: number): string {
  const naira = Math.trunc(kobo / 100);
  const rest = kobo % 100;
  return rest === 0 ? String(naira) : `${naira}.${String(rest).padStart(2, "0")}`;
}
