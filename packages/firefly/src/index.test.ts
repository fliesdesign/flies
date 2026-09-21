import { describe, expect, it } from "vite-plus/test";

import { Firefly, parseColor } from "./index";

describe("parseColor", () => {
  const cases: [string, [number, number, number, number]][] = [
    ["#000", [0, 0, 0, 1]],
    ["#fff", [1, 1, 1, 1]],
    ["#f80", [1, 136 / 255, 0, 1]],
    ["#1a2f", [17 / 255, 170 / 255, 34 / 255, 1]],
    ["#f808", [1, 136 / 255, 0, 136 / 255]],
    ["#123456", [18 / 255, 52 / 255, 86 / 255, 1]],
    ["#ABCDEF", [171 / 255, 205 / 255, 239 / 255, 1]],
    ["#ff804080", [1, 128 / 255, 64 / 255, 128 / 255]],
    ["#abcdef00", [171 / 255, 205 / 255, 239 / 255, 0]],
    ["12345678", [18 / 255, 52 / 255, 86 / 255, 120 / 255]],
  ];

  for (const [input, rgba] of cases) {
    it(`converts ${input} to normalized, unpremultiplied RGBA`, () => {
      expect(parseColor(input)).toEqual(rgba);
    });
  }
});

/** These failure tests exercise resource ownership, not WebGL drawing behavior. */
function initializationFailure(options: {
  compile?: boolean;
  link?: boolean;
  shaderLimit?: number;
}) {
  const program = {};
  const createdShaders: object[] = [];
  const deletedShaders: object[] = [];
  const deletedPrograms: object[] = [];

  const gl = {
    MAX_TEXTURE_SIZE: 0x0d33,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    getParameter: () => 4096,
    createProgram: () => program,
    createShader: (stage: number) => {
      if (createdShaders.length >= (options.shaderLimit ?? Infinity)) return null;
      const shader = { stage };
      createdShaders.push(shader);

      return shader;
    },
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => options.compile ?? true,
    getShaderInfoLog: () => "driver shader compilation failed",
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => options.link ?? true,
    getProgramInfoLog: () => "driver program linking failed",
    deleteProgram: (deleted: object) => deletedPrograms.push(deleted),
    deleteShader: (deleted: object) => deletedShaders.push(deleted),
  };

  const canvas = { getContext: () => gl } as unknown as HTMLCanvasElement;

  return {
    initialize: () => new Firefly(canvas, () => {}),
    assertReleased: (shaderCount: number) => {
      expect(createdShaders).toHaveLength(shaderCount);
      expect(deletedShaders).toEqual(createdShaders);
      expect(deletedPrograms).toEqual([program]);
    },
  };
}

describe("Firefly initialization failure", () => {
  it("reports an unavailable WebGL2 context without invoking the context-loss callback", () => {
    let contextLossCalls = 0;

    const canvas = {
      getContext: (name: string) => {
        expect(name).toBe("webgl2");

        return null;
      },
    } as unknown as HTMLCanvasElement;

    expect(() => new Firefly(canvas, () => contextLossCalls++)).toThrow(/WebGL2 is unavailable/);
    expect(contextLossCalls).toBe(0);
  });

  it("releases the failed shader and program when shader compilation fails", () => {
    const failure = initializationFailure({ compile: false });
    expect(failure.initialize).toThrow(/driver shader compilation failed/);
    failure.assertReleased(1);
  });

  it("releases both shaders and the program when program linking fails", () => {
    const failure = initializationFailure({ link: false });
    expect(failure.initialize).toThrow(/driver program linking failed/);
    failure.assertReleased(2);
  });

  it("releases earlier allocations when allocating the second shader fails", () => {
    const failure = initializationFailure({ shaderLimit: 1 });
    expect(failure.initialize).toThrow(/Could not allocate a Firefly shader/);
    failure.assertReleased(1);
  });
});

function recordingDevice() {
  const calls: { method: string; args: unknown[] }[] = [];
  let nextConstant = 1;
  let nextObject = 1;
  const constants = new Map<string, number>();

  const gl = new Proxy({} as WebGL2RenderingContext, {
    get(_target, property) {
      const name = String(property);

      if (/^[A-Z_\d]+$/.test(name)) {
        if (!constants.has(name)) constants.set(name, nextConstant++);

        return constants.get(name);
      }

      return (...args: unknown[]) => {
        calls.push({ method: name, args });
        if (name === "getParameter") return 8192;
        if (name === "getShaderParameter" || name === "getProgramParameter") return true;
        if (name === "checkFramebufferStatus") return gl.FRAMEBUFFER_COMPLETE;
        if (name === "getUniformLocation") return args[1];
        if (name.startsWith("create")) return { id: nextObject++ };

        return undefined;
      };
    },
  });

  const canvas = {
    width: 300,
    height: 150,
    style: {},
    getContext: () => gl,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HTMLCanvasElement;

  const lastCall = (method: string) => {
    for (let index = calls.length - 1; index >= 0; index--) {
      if (calls[index].method === method) return calls[index];
    }

    throw new Error(`No ${method} call was recorded.`);
  };

  return { device: new Firefly(canvas, () => {}), canvas, gl, calls, lastCall };
}

describe("Firefly effect overscan", () => {
  it("keeps the visible canvas size while presenting the center of a persistent expanded scene", () => {
    const { device, canvas, gl, lastCall } = recordingDevice();
    device.resize(120, 80, 2, 3.25);
    expect([canvas.width, canvas.height]).toEqual([240, 160]);
    expect([canvas.style.width, canvas.style.height]).toEqual(["120px", "80px"]);
    expect(device.effectPadding).toBe(3.5);
    device.begin();
    const scene = device.getTarget().surface!;
    expect([scene.texture.width, scene.texture.height]).toEqual([254, 174]);
    const effect = device.acquire();
    expect(effect).not.toBe(scene);
    expect([effect.texture.width, effect.texture.height]).toEqual([254, 174]);
    device.release(effect);
    device.present();
    expect(lastCall("blitFramebuffer").args).toEqual([
      7,
      7,
      247,
      167,
      0,
      0,
      240,
      160,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    ]);
    expect(device.getTarget().surface).toBe(scene);
    device.begin();
    expect(device.getTarget().surface).toBe(scene);
    device.destroy();
    expect(device.textureBytes).toBe(0);
  });

  it("uses expanded dimensions for filter sampling and backdrop copies", () => {
    const { device, calls, gl, lastCall } = recordingDevice();
    device.resize(100, 50, 2, 10);
    device.begin();
    const source = device.acquire();
    const filtered = device.filter(source, [{ kind: "blur", amount: 8 }], 1);

    const steps = calls.filter(
      (call) => call.method === "uniform2f" && call.args[0] === "uBlurStep",
    );

    expect(steps.map((call) => call.args.slice(1))).toEqual([
      [2 / 240, 0],
      [0, 2 / 140],
    ]);
    device.begin();
    device.composite(filtered, 1, 1);
    expect(lastCall("blitFramebuffer").args).toEqual([
      0,
      0,
      240,
      140,
      0,
      0,
      240,
      140,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    ]);
    device.release(filtered);
    device.destroy();
  });

  it("discards old scene and pooled surfaces when padding changes without resizing the canvas", () => {
    const { device, canvas, calls } = recordingDevice();
    device.resize(120, 80, 1, 10);
    device.begin();
    const previous = device.getTarget().surface!;
    const pooled = device.acquire();
    device.release(pooled);
    device.resize(120, 80, 1, 20);
    expect([canvas.width, canvas.height]).toEqual([120, 80]);

    const deleted = calls
      .filter((call) => call.method === "deleteFramebuffer")
      .map((call) => call.args[0]);

    expect(deleted).toEqual([previous.framebuffer, pooled.framebuffer]);
    expect(device.textureBytes).toBe(4);
    device.begin();
    expect(device.getTarget().surface).not.toBe(previous);
    expect(device.getTarget().surface!.texture.width).toBe(160);
    device.resize(120, 80, 1);
    device.begin();
    expect(device.getTarget().surface).toBeNull();
    expect(device.effectPadding).toBe(0);
    const blits = calls.filter((call) => call.method === "blitFramebuffer").length;
    device.present();
    expect(calls.filter((call) => call.method === "blitFramebuffer")).toHaveLength(blits);
    device.destroy();
  });
});
