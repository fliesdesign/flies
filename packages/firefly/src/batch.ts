import type { Matrix, Rect, Texture } from "./index";

const CAPACITY = 2048;
const STRIDE = 18;
const SLOTS = 8;

const vertex = `#version 300 es
precision highp float;
layout(location=0) in vec4 aMatrix;
layout(location=1) in vec4 aOriginSize;
layout(location=2) in vec4 aColor;
layout(location=3) in vec4 aStyle;
layout(location=4) in vec2 aPadding;
uniform vec2 uViewport;
uniform vec2 uOrigin;
out vec2 vUv;
flat out vec2 vSize;
flat out vec4 vColor;
flat out vec4 vStyle;
const vec2 corners[6]=vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));
void main() {
  vUv=corners[gl_VertexID]*(1.0+2.0*aPadding)-aPadding;
  vec2 p=mat2(aMatrix)*vUv+aOriginSize.xy-uOrigin;
  gl_Position=vec4(p/uViewport*vec2(2,-2)+vec2(-1,1),0,1);
  vSize=aOriginSize.zw; vColor=aColor; vStyle=aStyle;
}`;

const fragment = `#version 300 es
precision highp float;
in vec2 vUv;
flat in vec2 vSize;
flat in vec4 vColor;
flat in vec4 vStyle;
out vec4 outputColor;
uniform sampler2D uTextures[8];
vec4 sampleImage(int slot,vec2 uv,vec2 dx,vec2 dy) {
  switch(slot) {
    case 0:return textureGrad(uTextures[0],uv,dx,dy);
    case 1:return textureGrad(uTextures[1],uv,dx,dy);
    case 2:return textureGrad(uTextures[2],uv,dx,dy);
    case 3:return textureGrad(uTextures[3],uv,dx,dy);
    case 4:return textureGrad(uTextures[4],uv,dx,dy);
    case 5:return textureGrad(uTextures[5],uv,dx,dy);
    case 6:return textureGrad(uTextures[6],uv,dx,dy);
    default:return textureGrad(uTextures[7],uv,dx,dy);
  }
}
void main() {
  vec2 uv=vec2(vUv.x,vStyle.z>0.5?1.0-vUv.y:vUv.y);
  vec2 dx=dFdx(uv),dy=dFdy(uv);
  vec2 p=abs((vUv-.5)*vSize)-vSize*.5;
  float radius=vStyle.x;
  vec2 rounded=p+radius;
  float d=vStyle.y<0.0 ? length(max(rounded,vec2(0)))+min(max(rounded.x,rounded.y),0.0)-radius : max(p.x,p.y);
  float aa=max(fwidth(d),.0001);
  float coverage=1.0-smoothstep(-aa*.5,aa*.5,d);
  if(coverage<=0.0) discard;
  vec4 color=vStyle.y<0.0 ? vec4(vColor.rgb*vColor.a,vColor.a) : sampleImage(int(vStyle.y),uv,dx,dy);
  outputColor=color*(coverage*vStyle.w);
}`;

/** Ordered instanced quads. State-changing operations flush; artwork is never reordered. */
export class QuadBatch {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  private readonly viewport: WebGLUniformLocation;
  private readonly origin: WebGLUniformLocation;
  private readonly data = new Float32Array(CAPACITY * STRIDE);
  private readonly textures: Texture[] = [];
  private readonly bindings: (WebGLTexture | null)[] = Array.from({ length: SLOTS }, () => null);
  private count = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {
    const program = gl.createProgram();
    if (!program) throw new Error("Could not allocate the Firefly batch program.");
    const shaders: WebGLShader[] = [];

    try {
      for (const [kind, source] of [
        [gl.VERTEX_SHADER, vertex],
        [gl.FRAGMENT_SHADER, fragment],
      ] as const) {
        const shader = gl.createShader(kind);
        if (!shader) throw new Error("Could not allocate a Firefly batch shader.");
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(shader) ?? "Batch shader compilation failed.");
        gl.attachShader(program, shader);
      }

      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program) ?? "Batch program linking failed.");
    } catch (error) {
      gl.deleteProgram(program);
      throw error;
    } finally {
      for (const shader of shaders) gl.deleteShader(shader);
    }

    this.program = program;
    this.vao = gl.createVertexArray()!;
    this.buffer = gl.createBuffer()!;
    this.viewport = gl.getUniformLocation(program, "uViewport")!;
    this.origin = gl.getUniformLocation(program, "uOrigin")!;
    gl.useProgram(program);
    gl.uniform1iv(
      gl.getUniformLocation(program, "uTextures[0]"),
      new Int32Array([0, 1, 2, 3, 4, 5, 6, 7]),
    );
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);

    let offset = 0;

    for (const [index, size] of [4, 4, 4, 4, 2].entries()) {
      gl.enableVertexAttribArray(index);
      gl.vertexAttribPointer(index, size, gl.FLOAT, false, STRIDE * 4, offset * 4);
      gl.vertexAttribDivisor(index, 1);
      offset += size;
    }
  }

  get full() {
    return this.count === CAPACITY;
  }

  accepts(texture?: Texture) {
    return (
      !this.full && (!texture || this.textures.length < SLOTS || this.textures.includes(texture))
    );
  }

  add(
    rect: Rect,
    transform: Matrix,
    ratio: number,
    color: readonly number[],
    radius: number,
    opacity: number,
    texture?: Texture,
  ) {
    let slot = -1;

    if (texture) {
      slot = this.textures.indexOf(texture);

      if (slot < 0) {
        slot = this.textures.length;
        this.textures.push(texture);
      }
    }

    const offset = this.count++ * STRIDE;
    const a = transform.a * rect.width;
    const b = transform.b * rect.width;
    const c = transform.c * rect.height;
    const d = transform.d * rect.height;
    this.data.set(
      [
        a,
        b,
        c,
        d,
        transform.a * rect.x + transform.c * rect.y + transform.e,
        transform.b * rect.x + transform.d * rect.y + transform.f,
        rect.width,
        rect.height,
        color[0],
        color[1],
        color[2],
        color[3],
        Math.min(radius, rect.width / 2, rect.height / 2),
        slot,
        texture?.flipped ? 1 : 0,
        opacity,
        1 / Math.max(1, ratio * Math.hypot(a, b)),
        1 / Math.max(1, ratio * Math.hypot(c, d)),
      ],
      offset,
    );
  }

  invalidateTextures() {
    this.bindings.fill(null);
  }

  flush(
    width: number,
    height: number,
    originX: number,
    originY: number,
    empty: Texture,
    forbidden?: WebGLTexture,
  ) {
    if (!this.count) return false;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    // Give each submitted batch fresh storage. Overwriting a buffer still read
    // by earlier draws can serialize the CPU and GPU on native Metal drivers.
    gl.bufferData(gl.ARRAY_BUFFER, this.data, gl.STREAM_DRAW, 0, this.count * STRIDE);
    gl.uniform2f(this.viewport, width, height);
    gl.uniform2f(this.origin, originX, originY);

    for (let index = 0; index < SLOTS; index++) {
      const previous = this.bindings[index];

      const handle =
        this.textures[index]?.handle ??
        (previous && previous !== forbidden ? previous : empty.handle);

      if (handle !== previous) {
        gl.activeTexture(gl.TEXTURE0 + index);
        gl.bindTexture(gl.TEXTURE_2D, handle);
        this.bindings[index] = handle;
      }
    }

    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.count);
    this.count = 0;
    this.textures.length = 0;

    return true;
  }

  destroy() {
    this.count = 0;
    this.textures.length = 0;
    this.gl.deleteBuffer(this.buffer);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteProgram(this.program);
  }
}
