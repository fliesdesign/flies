import { QuadBatch } from "./batch";
import { GpuProfiler } from "./profiler";
import { fragment, vertex } from "./shaders";

export type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type Texture = {
  handle: WebGLTexture;
  width: number;
  height: number;
  flipped: boolean;
  byteLength: number;
};
export type Surface = {
  texture: Texture;
  framebuffer: WebGLFramebuffer;
  stencil: WebGLRenderbuffer;
  /** Pixel-aligned logical coordinates within the drawing scene. */
  bounds: Rect;
};
export type Filter = {
  kind: "blur" | "brightness" | "contrast" | "saturate" | "grayscale" | "sepia" | "invert" | "hue";
  amount: number;
};

const filterIds = {
  brightness: 1,
  contrast: 2,
  saturate: 3,
  grayscale: 4,
  sepia: 5,
  invert: 6,
  hue: 7,
  blur: 8,
};

const identity: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function parseColor(hex: string): [number, number, number, number] {
  let value = hex.replace("#", "");
  if (value.length <= 4) value = [...value].map((c) => c + c).join("");
  if (value.length === 6) value += "ff";

  return [0, 2, 4, 6].map((i) => Number.parseInt(value.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
    number,
  ];
}

/** Small OpenGL ES 3 / WebGL2 compositor. No scene graph, animation ticker or third-party engine. */
export class Firefly {
  readonly gl: WebGL2RenderingContext;
  readonly maxTextureSize: number;
  drawCalls = 0;
  primitiveCount = 0;
  clipCount = 0;
  textureUploads = 0;
  textureBytes = 0;
  surfaceTextureBytes = 0;
  surfaceBytes = 0;
  pooledSurfaceBytes = 0;
  readonly profiler: GpuProfiler;
  private readonly batch: QuadBatch;
  private readonly program: WebGLProgram;
  private readonly uniforms = new Map<string, WebGLUniformLocation>();
  private readonly matrix = new Float32Array(9);
  private readonly textures = new Set<Texture>();
  private readonly surfaces = new Set<Surface>();
  private readonly pool: Surface[] = [];
  private current: Surface | null = null;
  private scene: Surface | null = null;
  private stencilDepth = 0;
  private width = 1;
  private height = 1;
  private ratio = 1;
  private surfaceWidth = 1;
  private surfaceHeight = 1;
  private paddingPixels = 0;
  private disposed = false;
  private readonly vao: WebGLVertexArrayObject;
  private readonly empty: Texture;
  private readonly surfacePoolBudget: number;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly onLost: (error: Error) => void,
    options: { profiling?: boolean; surfacePoolBudget?: number } = {},
  ) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      stencil: true,
      depth: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });

    if (!gl) throw new Error("WebGL2 is unavailable.");
    this.gl = gl;
    this.surfacePoolBudget = options.surfacePoolBudget ?? 64 * 1024 * 1024;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const shaders: WebGLShader[] = [];
    const program = gl.createProgram();
    if (!program) throw new Error("Could not create the Firefly program.");

    try {
      for (const [type, source] of [
        [gl.VERTEX_SHADER, vertex],
        [gl.FRAGMENT_SHADER, fragment],
      ] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error("Could not allocate a Firefly shader.");
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(shader) ?? "Shader compilation failed.");
        gl.attachShader(program, shader);
      }

      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program) ?? "Shader link failed.");
    } catch (error) {
      gl.deleteProgram(program);
      throw error;
    } finally {
      shaders.forEach((shader) => gl.deleteShader(shader));
    }

    this.program = program;
    this.vao = gl.createVertexArray()!;
    gl.useProgram(program);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(this.location("uTexture"), 0);
    gl.uniform1i(this.location("uBackdrop"), 1);
    this.empty = this.allocateTexture(1, 1, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.empty.handle);

    try {
      this.batch = new QuadBatch(gl);
    } catch (error) {
      gl.deleteTexture(this.empty.handle);
      this.textures.clear();
      this.textureBytes = 0;
      gl.deleteVertexArray(this.vao);
      gl.deleteProgram(this.program);
      throw error;
    }

    this.profiler = new GpuProfiler(gl, options.profiling ?? false);
    canvas.addEventListener("webglcontextlost", this.handleLoss);
  }

  private handleLoss = (event: Event) => {
    event.preventDefault();
    if (!this.disposed) this.onLost(new Error("The WebGL context was lost."));
  };

  private location(name: string) {
    let location = this.uniforms.get(name);

    if (location === undefined) {
      const found = this.gl.getUniformLocation(this.program, name);
      if (found === null) throw new Error(`Missing Firefly uniform: ${name}`);
      location = found;
      this.uniforms.set(name, location);
    }

    return location;
  }

  /** Logical overscan after rounding to physical pixels; offset artwork by this amount. */
  get effectPadding() {
    return this.paddingPixels / this.ratio;
  }

  resize(width: number, height: number, ratio: number, padding = 0) {
    this.flush();
    const nextWidth = Math.max(1, Math.ceil(width * ratio));
    const nextHeight = Math.max(1, Math.ceil(height * ratio));
    const paddingPixels = Math.max(0, Math.ceil(padding * ratio));
    const surfaceWidth = nextWidth + paddingPixels * 2;
    const surfaceHeight = nextHeight + paddingPixels * 2;
    if (surfaceWidth > this.maxTextureSize || surfaceHeight > this.maxTextureSize)
      throw new Error("Canvas exceeds the device texture size.");
    this.width = Math.max(1, width) + (paddingPixels * 2) / ratio;
    this.height = Math.max(1, height) + (paddingPixels * 2) / ratio;
    this.ratio = ratio;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    const changed =
      this.canvas.width !== nextWidth ||
      this.canvas.height !== nextHeight ||
      this.surfaceWidth !== surfaceWidth ||
      this.surfaceHeight !== surfaceHeight ||
      this.paddingPixels !== paddingPixels;

    this.surfaceWidth = surfaceWidth;
    this.surfaceHeight = surfaceHeight;
    this.paddingPixels = paddingPixels;
    if (!changed) return;
    if (this.canvas.width !== nextWidth) this.canvas.width = nextWidth;
    if (this.canvas.height !== nextHeight) this.canvas.height = nextHeight;
    for (const surface of this.surfaces) this.deleteSurface(surface);
    this.pool.length = 0;
    this.pooledSurfaceBytes = 0;
    this.current = null;
    this.scene = null;
  }

  begin() {
    this.flush();
    this.profiler.begin();
    this.drawCalls = 0;
    this.primitiveCount = 0;
    this.clipCount = 0;
    if (this.paddingPixels > 0 && !this.scene) this.scene = this.acquire();
    this.target(this.scene, 0);
    this.clear();
  }

  /** Present only the visible center; overscan stays available to filters and blend passes. */
  present() {
    this.flush();

    if (!this.scene) {
      this.profiler.end();

      return;
    }

    const gl = this.gl;
    const destination = this.getTarget();
    const padding = this.paddingPixels;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.scene.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(
      padding,
      padding,
      padding + this.canvas.width,
      padding + this.canvas.height,
      0,
      0,
      this.canvas.width,
      this.canvas.height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    this.target(destination.surface, destination.depth);
    this.profiler.end();
  }

  getTarget() {
    return { surface: this.current, depth: this.stencilDepth };
  }

  target(surface: Surface | null, depth = 0) {
    this.flush();
    this.batch?.invalidateTextures();
    const gl = this.gl;
    this.current = surface;
    this.stencilDepth = depth;
    gl.bindFramebuffer(gl.FRAMEBUFFER, surface?.framebuffer ?? null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.empty.handle);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.empty.handle);
    gl.viewport(
      0,
      0,
      surface?.texture.width ?? this.canvas.width,
      surface?.texture.height ?? this.canvas.height,
    );
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.applyStencil();
  }

  clear() {
    this.flush();
    const gl = this.gl;
    gl.colorMask(true, true, true, true);
    gl.stencilMask(0xff);
    gl.clearColor(0, 0, 0, 0);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    this.applyStencil();
  }

  private applyStencil() {
    const gl = this.gl;
    if (this.stencilDepth) {
      gl.enable(gl.STENCIL_TEST);
      gl.stencilFunc(gl.EQUAL, this.stencilDepth, 0xff);
    } else gl.disable(gl.STENCIL_TEST);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.stencilMask(0);
  }

  texture(source: HTMLCanvasElement): Texture {
    const texture = this.allocateTexture(source.width, source.height, false);
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);

    let width = texture.width,
      height = texture.height;

    while (width > 1 || height > 1) {
      width = Math.max(1, Math.floor(width / 2));
      height = Math.max(1, Math.floor(height / 2));
      texture.byteLength += width * height * 4;
      this.textureBytes += width * height * 4;
    }

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    this.textureUploads++;

    return texture;
  }

  private allocateTexture(width: number, height: number, flipped: boolean): Texture {
    this.batch?.invalidateTextures();
    const gl = this.gl;
    if (width > this.maxTextureSize || height > this.maxTextureSize)
      throw new Error("Artwork exceeds device texture size.");
    const handle = gl.createTexture();
    if (!handle) throw new Error("Could not allocate a Firefly texture.");
    const texture = { handle, width, height, flipped, byteLength: width * height * 4 };
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, handle);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.add(texture);
    this.textureBytes += width * height * 4;

    return texture;
  }

  deleteTexture(texture: Texture) {
    this.flush();
    this.batch?.invalidateTextures();
    if (!this.textures.delete(texture)) return;
    this.gl.deleteTexture(texture.handle);
    this.textureBytes -= texture.byteLength;
  }

  acquire(bounds: Rect = { x: 0, y: 0, width: this.width, height: this.height }): Surface {
    const x = Math.floor(bounds.x * this.ratio);
    const y = Math.floor(bounds.y * this.ratio);
    const width = Math.max(1, Math.ceil((bounds.x + bounds.width) * this.ratio) - x);
    const height = Math.max(1, Math.ceil((bounds.y + bounds.height) * this.ratio) - y);

    const aligned = {
      x: x / this.ratio,
      y: y / this.ratio,
      width: width / this.ratio,
      height: height / this.ratio,
    };

    const index = this.pool.findIndex(
      (surface) => surface.texture.width === width && surface.texture.height === height,
    );

    if (index >= 0) {
      const available = this.pool.splice(index, 1)[0];
      this.pooledSurfaceBytes -= available.texture.width * available.texture.height * 5;
      available.bounds = aligned;

      return available;
    }

    this.flush();
    const gl = this.gl;
    const texture = this.allocateTexture(width, height, true);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      texture.width,
      texture.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    const framebuffer = gl.createFramebuffer()!;
    const stencil = gl.createRenderbuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture.handle, 0);
    gl.bindRenderbuffer(gl.RENDERBUFFER, stencil);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.STENCIL_INDEX8, texture.width, texture.height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.STENCIL_ATTACHMENT, gl.RENDERBUFFER, stencil);
    const surface = { texture, framebuffer, stencil, bounds: aligned };
    this.surfaces.add(surface);
    this.surfaceTextureBytes += texture.byteLength;
    this.surfaceBytes += width * height * 5;

    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      this.deleteSurface(surface);
      throw new Error("Incomplete Firefly framebuffer.");
    }

    this.target(this.current, this.stencilDepth);

    return surface;
  }

  release(surface: Surface) {
    if (surface === this.scene) return;
    const bytes = surface.texture.width * surface.texture.height * 5;

    if (this.pool.length < 8 && this.pooledSurfaceBytes + bytes <= this.surfacePoolBudget) {
      this.pool.push(surface);
      this.pooledSurfaceBytes += bytes;
    } else this.deleteSurface(surface);
  }

  private deleteSurface(surface: Surface) {
    if (!this.surfaces.delete(surface)) return;
    this.surfaceTextureBytes -= surface.texture.byteLength;
    this.surfaceBytes -= surface.texture.width * surface.texture.height * 5;
    this.deleteTexture(surface.texture);
    this.gl.deleteFramebuffer(surface.framebuffer);
    this.gl.deleteRenderbuffer(surface.stencil);
  }

  private prepare(rect: Rect, transform: Matrix, opacity: number) {
    this.flush();
    this.batch.invalidateTextures();
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    const m = this.matrix;
    const bounds = this.current?.bounds;
    m[0] = transform.a * rect.width;
    m[1] = transform.b * rect.width;
    m[2] = 0;
    m[3] = transform.c * rect.height;
    m[4] = transform.d * rect.height;
    m[5] = 0;
    m[6] = transform.a * rect.x + transform.c * rect.y + transform.e - (bounds?.x ?? 0);
    m[7] = transform.b * rect.x + transform.d * rect.y + transform.f - (bounds?.y ?? 0);
    m[8] = 1;
    gl.uniformMatrix3fv(this.location("uMatrix"), false, m);
    gl.uniform2f(
      this.location("uViewport"),
      bounds?.width ?? this.canvas.width / this.ratio,
      bounds?.height ?? this.canvas.height / this.ratio,
    );
    gl.uniform1f(this.location("uOpacity"), opacity);
    gl.uniform2f(this.location("uPadding"), 0, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.empty.handle);
    gl.uniform1i(this.location("uBlend"), 0);
    gl.uniform1i(this.location("uFilter"), 0);
    gl.uniform1i(this.location("uTextureEdges"), 0);
  }

  rect(rect: Rect, transform: Matrix, color: readonly number[], radius = 0, opacity = 1) {
    if (!this.batch.accepts()) this.flush();
    this.batch.add(rect, transform, this.ratio, color, radius, opacity);
    this.primitiveCount++;
  }

  image(texture: Texture, rect: Rect, transform: Matrix, opacity = 1) {
    if (!this.batch.accepts(texture)) this.flush();
    this.batch.add(rect, transform, this.ratio, [1, 1, 1, 1], 0, opacity, texture);
    this.primitiveCount++;
  }

  /** Submit queued artwork before reading pixels or changing external GL state. */
  flush() {
    const bounds = this.current?.bounds;
    if (
      this.batch?.flush(
        bounds?.width ?? this.canvas.width / this.ratio,
        bounds?.height ?? this.canvas.height / this.ratio,
        bounds?.x ?? 0,
        bounds?.y ?? 0,
        this.empty,
        this.current?.texture.handle,
      )
    )
      this.drawCalls++;
  }

  private bindImage(texture: Texture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture.handle);
    gl.uniform1i(this.location("uMode"), 1);
    gl.uniform1i(this.location("uFlip"), texture.flipped ? 1 : 0);
  }

  clip(rect: Rect, matrix: Matrix, radius: number, push: boolean) {
    this.flush();
    const gl = this.gl;
    if (push && this.stencilDepth >= 254)
      throw new Error("Canvas clipping nesting exceeds the device limit.");
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    gl.stencilFunc(gl.EQUAL, this.stencilDepth, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, push ? gl.INCR : gl.DECR);
    gl.colorMask(false, false, false, false);
    this.rect(rect, matrix, [1, 1, 1, 1], radius);
    this.flush();
    this.primitiveCount--;
    this.clipCount++;
    gl.colorMask(true, true, true, true);
    this.stencilDepth += push ? 1 : -1;
    this.applyStencil();
  }

  composite(source: Surface, opacity: number, blend = 0) {
    this.flush();
    const destination = this.getTarget();
    let backdrop: Surface | undefined;

    if (blend) {
      backdrop = this.acquire(source.bounds);
      const gl = this.gl;
      this.target(backdrop);
      this.clear();

      const destinationBounds = destination.surface?.bounds ?? {
        x: 0,
        y: 0,
        width: this.canvas.width / this.ratio,
        height: this.canvas.height / this.ratio,
      };

      const x = Math.max(source.bounds.x, destinationBounds.x);
      const y = Math.max(source.bounds.y, destinationBounds.y);

      const right = Math.min(
        source.bounds.x + source.bounds.width,
        destinationBounds.x + destinationBounds.width,
      );

      const bottom = Math.min(
        source.bounds.y + source.bounds.height,
        destinationBounds.y + destinationBounds.height,
      );

      const destinationHeight = destination.surface?.texture.height ?? this.canvas.height;
      const sx = Math.round((x - destinationBounds.x) * this.ratio);
      const sy = destinationHeight - Math.round((bottom - destinationBounds.y) * this.ratio);
      const dx = Math.round((x - source.bounds.x) * this.ratio);
      const dy = backdrop.texture.height - Math.round((bottom - source.bounds.y) * this.ratio);
      const width = Math.max(0, Math.round((right - x) * this.ratio));
      const height = Math.max(0, Math.round((bottom - y) * this.ratio));
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, destination.surface?.framebuffer ?? null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, backdrop.framebuffer);
      gl.blitFramebuffer(
        sx,
        sy,
        sx + width,
        sy + height,
        dx,
        dy,
        dx + width,
        dy + height,
        gl.COLOR_BUFFER_BIT,
        gl.NEAREST,
      );
      this.target(destination.surface, destination.depth);
    }

    this.prepare(source.bounds, identity, opacity);
    this.bindImage(source.texture);

    if (backdrop) {
      this.gl.activeTexture(this.gl.TEXTURE1);
      this.gl.bindTexture(this.gl.TEXTURE_2D, backdrop.texture.handle);
    }

    this.gl.uniform1i(this.location("uBlend"), blend);
    this.draw();
    if (backdrop) this.release(backdrop);
  }

  /** Takes ownership of the source surface and returns the final filtered surface. */
  filter(source: Surface, filters: readonly Filter[], scale: number): Surface {
    let current = source;

    for (const filter of filters) {
      const passes = filter.kind === "blur" ? 2 : 1;
      if (filter.kind === "blur" && filter.amount <= 0) continue;

      for (let pass = 0; pass < passes; pass++) {
        const next = this.acquire(current.bounds);
        this.target(next);
        this.clear();
        this.prepare(current.bounds, identity, 1);
        this.bindImage(current.texture);
        const gl = this.gl;
        gl.uniform1i(this.location("uFilter"), filterIds[filter.kind]);
        gl.uniform1f(this.location("uAmount"), filter.amount);
        const step = (filter.amount * scale * this.ratio) / 8;
        gl.uniform2f(
          this.location("uBlurStep"),
          pass === 0 ? step / current.texture.width : 0,
          pass === 1 ? step / current.texture.height : 0,
        );
        this.draw();
        this.release(current);
        current = next;
      }
    }

    return current;
  }

  /** Consume two aligned layers and return content multiplied by the mask's painted alpha. */
  mask(content: Surface, mask: Surface): Surface {
    if (
      content === mask ||
      content.bounds.x !== mask.bounds.x ||
      content.bounds.y !== mask.bounds.y ||
      content.texture.width !== mask.texture.width ||
      content.texture.height !== mask.texture.height
    )
      throw new Error("Alpha-mask layers must be distinct and have matching bounds.");
    const result = this.acquire(content.bounds);
    this.target(result);
    this.clear();
    this.prepare(content.bounds, identity, 1);
    this.bindImage(content.texture);
    this.gl.activeTexture(this.gl.TEXTURE1);
    this.gl.bindTexture(this.gl.TEXTURE_2D, mask.texture.handle);
    this.gl.uniform1i(this.location("uFilter"), 9);
    this.draw();
    this.release(content);
    this.release(mask);

    return result;
  }

  private draw() {
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    this.drawCalls++;
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.profiler.destroy();
    this.batch.destroy();
    this.canvas.removeEventListener("webglcontextlost", this.handleLoss);
    for (const surface of this.surfaces) this.deleteSurface(surface);
    for (const texture of this.textures) this.deleteTexture(texture);
    this.pool.length = 0;
    this.pooledSurfaceBytes = 0;
    this.scene = null;
    this.current = null;
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.program);
  }
}
