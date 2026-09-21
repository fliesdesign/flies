const MAX_TEXTURE_EDGE = 4096;
const MAX_TEXTURE_PIXELS = 4_194_304;

/** Pixi pools text canvases in powers of two. Bound the backing allocation, not
 * just the glyph bounds. A 2x floor avoids resampling already-antialiased glyphs
 * from a 1x texture when a label sits at fractional canvas coordinates. */
export function textRasterResolution(width: number, height: number, density: number, zoom: number) {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  const bucket = 2 ** Math.ceil(Math.log2(Math.max(2, density * zoom)));
  let resolution = Math.min(bucket, MAX_TEXTURE_EDGE / w, MAX_TEXTURE_EDGE / h);

  const backingSize = (size: number) =>
    2 ** Math.ceil(Math.log2(Math.max(1, Math.ceil(size * resolution))));

  while (backingSize(w) * backingSize(h) > MAX_TEXTURE_PIXELS) resolution /= 2;

  return resolution;
}
