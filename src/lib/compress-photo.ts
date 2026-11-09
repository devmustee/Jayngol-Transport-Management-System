// The server refuses anything over about 500 KB (src/lib/photo.ts).
const MAX_DATA_URL = 660_000;
const STEPS = [
  [1280, 0.7],
  [1024, 0.6],
  [800, 0.5],
  [640, 0.4],
] as const;

/** Shrinks a camera photo to a JPEG small enough for a weak connection. */
export async function compressPhoto(file: File): Promise<string> {
  const image = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    for (const [side, quality] of STEPS) {
      const scale = Math.min(1, side / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/jpeg", quality);
      if (url.length <= MAX_DATA_URL) return url;
    }
  } finally {
    image.close();
  }
  throw new Error("Photo too large");
}
