export { sanitizeCanvasSvg as sanitizeSnapshotSvg } from "@flies/canvas";

export function withSnapshotTimeout<T>(promise: Promise<T>, milliseconds = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error("Snapshot image decoding timed out.")),
      milliseconds,
    );

    promise.then(
      (value) => {
        window.clearTimeout(timer);

        return resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);

        return reject(error);
      },
    );
  });
}
