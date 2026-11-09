import { z } from "zod";

/** Photos are compressed on the phone, so anything bigger was not made by the app. */
export const MAX_PHOTO_BYTES = 500_000;

const PREFIX = "data:image/jpeg;base64,";
const MAX_LENGTH = PREFIX.length + Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 4;

export const photoBytes = (dataUrl: string) => Buffer.from(dataUrl.slice(PREFIX.length), "base64");

const isJpeg = (dataUrl: string) => {
  const head = photoBytes(dataUrl.slice(0, PREFIX.length + 8));
  return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
};

export const photoField = (label: string) =>
  z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z
      .string()
      .max(MAX_LENGTH, `${label} is too large`)
      .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/, `${label} is not a valid image`)
      .refine(isJpeg, `${label} is not a valid image`)
      .optional(),
  );
