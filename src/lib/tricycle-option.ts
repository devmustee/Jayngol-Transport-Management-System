import { formatNaira } from "./money";

export type TricycleOption = {
  id: string;
  codeNumber: string;
  registrationNumber: string;
  dailyBalanceKobo: number | null;
};

/** How an in-stock tricycle reads in an issue list, with what it will charge. */
export const tricycleOptionLabel = (t: TricycleOption) =>
  `${t.codeNumber} (${t.registrationNumber}) · ${
    t.dailyBalanceKobo == null ? "daily balance not set" : `${formatNaira(t.dailyBalanceKobo)} a day`
  }`;
