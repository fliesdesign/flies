const MAX_URL_LENGTH = 8192;
const MAX_REMOTE_IMAGES = 32;
const MAX_BYTES = 5_000_000;
const RASTER_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/]+={0,2}$/i;
const RASTER_TYPE = /^image\/(?:png|jpeg|gif|webp|avif)$/i;
const PRIVATE_HOST = /^(?:localhost|.*\.(?:localhost|local|internal)|[\d.]+|\[.*\])$/i;

const remoteImages = new WeakMap<HTMLElement, string>();

function imageError(message: string, cause: unknown) {
  const error = new Error(message);
  Object.defineProperty(error, "cause", { value: cause });

  return error;
}

/** Canonical public http(s) URL, or undefined when the value must not be fetched. */
export function publicImageUrl(value: string): string | undefined {
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return undefined;
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  const host = url.hostname.replace(/\.$/, "");

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !host.includes(".") ||
    host.includes(":") ||
    PRIVATE_HOST.test(host)
  )
    return undefined;
  url.hostname = host;
  url.hash = "";

  return url.href;
}

export function rememberRemoteImage(image: HTMLElement, url: string) {
  remoteImages.set(image, url);
}

/** Download a public raster once and return embedded pixels for the canvas document. */
export async function loadRemoteImage(source: string): Promise<string> {
  const url = publicImageUrl(source);

  if (!url) throw new Error("Images must use a public HTTP or HTTPS URL.");

  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 5000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
    });

    const type = response.headers.get("content-type")?.split(";")[0].trim() ?? "";

    if (!response.ok || !RASTER_TYPE.test(type) || !response.body)
      throw new Error("The image could not be downloaded.");
    if (Number(response.headers.get("content-length")) > MAX_BYTES)
      throw new Error("Images must be smaller than 5 MB.");
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;

    try {
      while (true) {
        // Read incrementally so a missing Content-Length cannot bypass the limit.
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Error("Images must be smaller than 5 MB.");
        chunks.push(new Uint8Array(value));
      }
    } finally {
      controller.abort();
      reader.releaseLock();
    }

    const { readCanvasImage } = await import("@flies/canvas");
    const image = await readCanvasImage(new File(chunks, "Image", { type }));

    return image.src;
  } catch (error) {
    if (timedOut) throw imageError("The image download timed out.", error);
    if (error instanceof Error) throw error;
    throw imageError("The image could not be downloaded.", error);
  } finally {
    clearTimeout(timer);
  }
}

/** Replace accepted remote image URLs with data URLs before the fragment is mounted. */
export async function embedRemoteImages(
  root: ParentNode,
  loadImage: (url: string) => Promise<string>,
) {
  const pending: { image: HTMLImageElement; url: string }[] = [];

  for (const image of root.querySelectorAll("img")) {
    const remembered = remoteImages.get(image);
    const remote = remembered ?? publicImageUrl(image.getAttribute("src") ?? "");
    if (!remote) continue;
    remoteImages.delete(image);
    image.removeAttribute("src");
    pending.push({ image, url: remote });
  }

  if (pending.length > MAX_REMOTE_IMAGES)
    throw new Error("HTML imports are limited to 32 remote images.");

  for (const { image, url } of pending) {
    // Download one image at a time so a section cannot fan out unbounded fetches.
    // eslint-disable-next-line no-await-in-loop
    const embedded = await loadImage(url);
    if (!RASTER_DATA_URL.test(embedded))
      throw new Error("Remote images must be PNG, JPEG, GIF, WebP, or AVIF.");
    image.src = embedded;
  }
}
