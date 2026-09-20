import { readCanvasSvg } from "./canvas-svg";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const PRESERVE_FILE_BYTES = 1024 * 1024;
const MAX_IMAGE_DIMENSION = 2048;
const RASTER_MIME = /^image\/(?:png|jpeg|webp|gif|avif)$/i;

export type CanvasImage = {
  kind: "image" | "svg";
  src: string;
  width: number;
  height: number;
  name: string;
};

function dataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
    reader.addEventListener("error", () => reject(new Error("This image could not be read.")), {
      once: true,
    });
    reader.addEventListener("abort", () => reject(new Error("Image import was cancelled.")), {
      once: true,
    });
    reader.readAsDataURL(file);
  });
}

/** Decode local files only; preserve sanitized SVG vectors and bound stored image sizes. */
export async function readCanvasImage(file: File): Promise<CanvasImage> {
  if (file.size > MAX_FILE_BYTES) throw new Error("Choose an image smaller than 20 MB.");
  if (!file.type.startsWith("image/") && !/\.(?:png|jpe?g|webp|gif|avif|svg)$/i.test(file.name))
    throw new Error("Choose a PNG, JPEG, WebP, GIF, AVIF, or SVG image.");

  if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name))
    return readCanvasSvg(await file.text(), file.name.replace(/\.[^.]+$/, "") || "SVG");

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    try {
      await image.decode();
    } catch {
      throw new Error("This image could not be decoded. Try a PNG, JPEG, or WebP file.");
    }
    if (image.naturalWidth === 0 || image.naturalHeight === 0)
      throw new Error("This image has no readable dimensions.");

    const scale = Math.min(
      1,
      MAX_IMAGE_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    let src: string;
    if (
      scale === 1 &&
      file.size <= PRESERVE_FILE_BYTES &&
      RASTER_MIME.test(file.type) &&
      !/\.svg$/i.test(file.name)
    ) {
      src = await dataUrl(file);
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser could not prepare the image.");
      context.drawImage(image, 0, 0, width, height);
      src = canvas.toDataURL("image/webp", 0.85);
      if (src === "data:,") throw new Error("This image could not be prepared.");
    }
    return {
      kind: "image",
      src,
      width,
      height,
      name: file.name.replace(/\.[^.]+$/, "") || "Image",
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
