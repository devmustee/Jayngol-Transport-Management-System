/** Shared by the payment and deposit forms. */
export const METHODS = [
  { value: "cash", label: "Cash" },
  { value: "pos", label: "POS" },
  { value: "transfer", label: "Transfer" },
];

export const CHOICE =
  "flex min-h-11 flex-1 cursor-pointer items-center justify-center rounded-lg border border-line bg-card px-3 font-semibold has-checked:border-ink has-checked:bg-ink has-checked:text-gold-light";
