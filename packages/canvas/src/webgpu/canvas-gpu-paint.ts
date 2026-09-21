import {
  AlphaFilter,
  BlendModeFilter,
  BlurFilter,
  ColorMatrixFilter,
  FillGradient,
  type Filter,
} from "pixi.js";

import {
  CANVAS_FILTERS,
  canvasFilterOrder,
  gradientLine,
  type CanvasBlendMode,
  type CanvasGradient,
  type CanvasFilters,
} from "../canvas-paint";

function rgba(color: string) {
  let hex = color.slice(1);
  if (hex.length <= 4)
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");

  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
    hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
  ];
}

/** Canvas gradients interpolate straight alpha; CSS interpolates premultiplied alpha. */
function toOklab(rgb: number[]) {
  const [r, g, b] = rgb.map((v) => {
    const n = v / 255;

    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  });

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b),
    m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b),
    s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]: number[]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(
    (v) =>
      Math.max(0, Math.min(1, v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)) * 255,
  );
}

function premultipliedStops(gradient: CanvasGradient) {
  const stops: { offset: number; color: string }[] = [];

  for (let i = 0; i < gradient.stops.length - 1; i++) {
    const from = gradient.stops[i],
      to = gradient.stops[i + 1],
      a = rgba(from.color),
      b = rgba(to.color);

    const ca = gradient.interpolation === "oklab" ? toOklab(a.slice(0, 3)) : a;
    const cb = gradient.interpolation === "oklab" ? toOklab(b.slice(0, 3)) : b;
    const steps = Math.max(1, Math.ceil((to.offset - from.offset) * 512));

    for (let step = 0; step < steps; step++) {
      const t = step / steps,
        alpha = a[3] * (1 - t) + b[3] * t;

      let channels = [0, 1, 2].map((c) =>
        alpha ? (ca[c] * a[3] * (1 - t) + cb[c] * b[3] * t) / alpha : 0,
      );

      if (gradient.interpolation === "oklab") channels = fromOklab(channels);

      const color =
        "#" +
        [...channels, alpha * 255].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");

      stops.push({ offset: from.offset + (to.offset - from.offset) * t, color });
    }
  }

  stops.push({ ...gradient.stops[gradient.stops.length - 1] });

  return stops;
}

export function gpuGradient(gradient: CanvasGradient, width: number, height: number) {
  const common = {
    colorStops: premultipliedStops(gradient),
    textureSpace: "global" as const,
    textureSize: 1024,
  };

  if (gradient.type === "radial")
    return new FillGradient({
      ...common,
      type: "radial",
      center: { x: width / 2, y: height / 2 },
      outerCenter: { x: width / 2, y: height / 2 },
      innerRadius: 0,
      outerRadius: width / Math.SQRT2,
      scale: height / width,
    });
  const { start, end } = gradientLine(width, height, gradient.angle);

  // Build a forward ramp, then retain the signed direction in its texture matrix.
  const fill = new FillGradient({
    ...common,
    type: "linear",
    start: { x: 0, y: 0 },
    end: { x: 1, y: 0 },
  });

  fill.buildGradient();

  const dx = end.x - start.x,
    dy = end.y - start.y,
    length = Math.hypot(dx, dy);

  fill.transform.set(dx / 1024, dy / 1024, -dy / length, dx / length, start.x, start.y);

  return fill;
}

/** CSS filter matrices use unpremultiplied sRGB; offsets here are normalized, not bytes. */
export function gpuFilters(values?: CanvasFilters, zoom = 1): Filter[] {
  const filters: Filter[] = [];

  for (const key of canvasFilterOrder(values)) {
    const v = values?.[key];
    if (v === undefined || v === CANVAS_FILTERS[key].initial) continue;

    if (key === "blur") {
      // Pixi's 15-tap kernel has sigma ~2.02 at strength 1; CSS blur is sigma.
      const weights = [0.000489, 0.002403, 0.009246, 0.02784, 0.065602, 0.120999, 0.174697];
      const variance = 2 * weights.reduce((sum, weight, i) => sum + weight * (7 - i) ** 2, 0);

      const blur = new BlurFilter({
        strength: (v * zoom) / Math.sqrt(variance),
        quality: 4,
        kernelSize: 15,
      });

      blur.padding = Math.ceil(3 * v * zoom);
      filters.push(blur);
      continue;
    }

    let rgb: number[][];
    let offset = 0;

    if (key === "brightness" || key === "contrast" || key === "invert") {
      const scale = key === "invert" ? 1 - 2 * v : v;
      offset = key === "contrast" ? 0.5 * (1 - v) : key === "invert" ? v : 0;
      rgb = [
        [scale, 0, 0],
        [0, scale, 0],
        [0, 0, scale],
      ];
    } else if (key === "sepia") {
      rgb = [
        [1 - 0.607 * v, 0.769 * v, 0.189 * v],
        [0.349 * v, 1 - 0.314 * v, 0.168 * v],
        [0.272 * v, 0.534 * v, 1 - 0.869 * v],
      ];
    } else if (key === "hue") {
      const c = Math.cos((v * Math.PI) / 180),
        s = Math.sin((v * Math.PI) / 180);

      rgb = [
        [
          0.213 + 0.787 * c - 0.213 * s,
          0.715 - 0.715 * c - 0.715 * s,
          0.072 - 0.072 * c + 0.928 * s,
        ],
        [
          0.213 - 0.213 * c + 0.143 * s,
          0.715 + 0.285 * c + 0.14 * s,
          0.072 - 0.072 * c - 0.283 * s,
        ],
        [
          0.213 - 0.213 * c - 0.787 * s,
          0.715 - 0.715 * c + 0.715 * s,
          0.072 + 0.928 * c + 0.072 * s,
        ],
      ];
    } else {
      const s = key === "grayscale" ? 1 - v : v;
      rgb = [
        [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
        [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
        [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
      ];
    }

    const filter = new ColorMatrixFilter();
    filter.matrix = [
      rgb[0][0],
      rgb[0][1],
      rgb[0][2],
      0,
      offset,
      rgb[1][0],
      rgb[1][1],
      rgb[1][2],
      0,
      offset,
      rgb[2][0],
      rgb[2][1],
      rgb[2][2],
      0,
      offset,
      0,
      0,
      0,
      1,
      0,
    ];
    filters.push(filter);
  }

  return filters;
}

/** W3C compositing: blend unpremultiplied colors, then source-over exactly once. */
export function gpuBlend(mode: CanvasBlendMode): Filter {
  if (mode === "normal") return new AlphaFilter();

  const scalar: Record<string, string> = {
    multiply: "base * source",
    screen: "base + source - base * source",
    overlay: "select(1.0-2.0*(1.0-base)*(1.0-source),2.0*base*source,base<=0.5)",
    darken: "min(base,source)",
    lighten: "max(base,source)",
    "color-dodge": "select(min(1.0,base/max(0.00001,1.0-source)),0.0,base<=0.0)",
    "color-burn": "select(1.0-min(1.0,(1.0-base)/max(0.00001,source)),1.0,base>=1.0)",
    "hard-light": "select(1.0-2.0*(1.0-base)*(1.0-source),2.0*base*source,source<=0.5)",
    "soft-light":
      "select(base+(2.0*source-1.0)*(select(sqrt(base),((16.0*base-12.0)*base+4.0)*base,base<=0.25)-base),base-(1.0-2.0*source)*base*(1.0-base),source<=0.5)",
    difference: "abs(base-source)",
    exclusion: "base+source-2.0*base*source",
  };

  const functions = `
    fn lum(c:vec3<f32>)->f32 { return dot(c,vec3<f32>(0.3,0.59,0.11)); }
    fn sat(c:vec3<f32>)->f32 { return max(c.r,max(c.g,c.b))-min(c.r,min(c.g,c.b)); }
    fn clipColor(input:vec3<f32>)->vec3<f32> {
      var c=input; let l=lum(c);let n=min(c.r,min(c.g,c.b));let x=max(c.r,max(c.g,c.b));
      if(n<0.0){c=vec3<f32>(l)+(c-vec3<f32>(l))*l/max(0.00001,l-n);}
      if(x>1.0){c=vec3<f32>(l)+(c-vec3<f32>(l))*(1.0-l)/max(0.00001,x-l);}return c;
    }
    fn setLum(c:vec3<f32>,l:f32)->vec3<f32>{return clipColor(c+vec3<f32>(l-lum(c)));}
    fn setSat(c:vec3<f32>,s:f32)->vec3<f32>{let n=min(c.r,min(c.g,c.b));let x=max(c.r,max(c.g,c.b));return (c-vec3<f32>(n))*s/max(0.00001,x-n);}
    fn channel(base:f32,source:f32)->f32 {return ${scalar[mode] ?? "source"};}
  `;

  const blend =
    mode === "hue"
      ? "setLum(setSat(s,sat(b)),lum(b))"
      : mode === "saturation"
        ? "setLum(setSat(b,sat(s)),lum(b))"
        : mode === "color"
          ? "setLum(s,lum(b))"
          : mode === "luminosity"
            ? "setLum(b,lum(s))"
            : "vec3<f32>(channel(b.r,s.r),channel(b.g,s.g),channel(b.b,s.b))";

  const filter = new BlendModeFilter({
    gpu: {
      functions,
      main: `let s=front.rgb/max(front.a,0.00001);let b=back.rgb/max(back.a,0.00001);let blended=${blend};out=vec4<f32>(front.rgb*(1.0-back.a)+back.rgb*(1.0-front.a)+blended*front.a*back.a,blendedAlpha);`,
    },
    // This renderer is explicitly WebGPU; the GL program is not used.
    gl: { functions: "", main: "finalColor = front + back * (1.0 - front.a);" },
  });

  filter.blendMode = "none";

  return filter;
}

/** BlurFilter owns two pass shaders that Pixi's base destroy does not release. */
export function destroyPaintFilter(filter: Filter) {
  if (filter instanceof BlurFilter) {
    filter.blurXFilter.destroy();
    filter.blurYFilter.destroy();
  }

  filter.destroy();
}
