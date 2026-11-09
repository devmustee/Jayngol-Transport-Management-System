import { z } from "zod";
import { isUuid } from "./fields";
import { queryValue } from "./format";

const date = (value: unknown) => {
  const text = queryValue(value);
  return z.iso.date().safeParse(text).success ? text : undefined;
};
const id = (value: unknown) => {
  const text = queryValue(value);
  return text && isUuid(text) ? text : undefined;
};

/** Reads filters from the address bar, ignoring anything malformed. */
export function readHistoryFilter(params: Record<string, unknown>) {
  const type = queryValue(params.type);
  return {
    tricycleId: id(params.tricycleId),
    itemId: id(params.itemId),
    type: type === "service" || type === "maintenance" ? type : undefined,
    from: date(params.from),
    to: date(params.to),
  } as const;
}
