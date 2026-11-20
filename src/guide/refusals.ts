/**
 * Refusals that a Guide topic explains. When a save is refused with one of
 * these, the message links to the topic, so the person can see the rule
 * rather than guess. `says` is a piece of the message exactly as the service
 * writes it; a test checks each one is still there.
 */
export const REFUSALS: { says: string; topic: string }[] = [
  // Cash close
  { says: "This count has already been corrected once.", topic: "correct-count" },
  { says: "A later count has been made since, so this one can no longer be corrected.", topic: "correct-count" },
  { says: "A count of your own cash can only be corrected the day it was made or the next day.", topic: "correct-count" },
  { says: "The Manager made this count, so only the Manager can correct it.", topic: "correct-count" },
  { says: "This person has left and the count moved their cash to the Manager", topic: "correct-count" },
  { says: "A later day is already closed, so this day is covered by that count.", topic: "cash-close" },
  { says: "You can only close your own cash.", topic: "cash-close" },
  // Payments and the bank
  { says: "This reference has already been used on another payment or deposit", topic: "record-payment" },
  { says: "which you recorded.", topic: "bank-confirm" },
  { says: "Only the person who confirmed it can undo it.", topic: "bank-confirm" },
  { says: "Only a confirmation made today can be undone.", topic: "bank-confirm" },
  { says: "Set the opening bank balance first", topic: "bank-reconcile" },
  { says: "A month has been reconciled, so the opening balance is fixed.", topic: "bank-reconcile" },
  { says: "This month has already been corrected once.", topic: "bank-reconcile" },
  // Expenses, loans, contributions
  { says: "Someone else must approve an expense you recorded.", topic: "record-expense" },
  { says: "already has a loan to clear", topic: "loans" },
  { says: "Part of this loan has been repaid, so it cannot be cancelled.", topic: "loans" },
  { says: "Part of this week is paid.", topic: "contributions" },
  { says: "This operator has paid since the alert", topic: "sacking" },
  // Tricycles and operators
  { says: "This operator still has a tricycle. Return it first.", topic: "operator-left" },
  { says: "Only a tricycle that is in stock can be retired.", topic: "add-tricycle" },
  // Field work
  { says: "Someone else must confirm an offence you raised.", topic: "offences" },
  { says: "This operator already has this offence for that night.", topic: "offences" },
  { says: "There is not enough left in the store.", topic: "store" },
  { says: "Parts can only go to a tricycle in the workshop.", topic: "store" },
  { says: "Return the parts to the store before cancelling.", topic: "workshop" },
  { says: "still have no attendance marked", topic: "meetings" },
  { says: "Attendance opens on the day of the meeting.", topic: "meetings" },
  // Staff
  { says: "You cannot disable your own login.", topic: "staff-logins" },
];
