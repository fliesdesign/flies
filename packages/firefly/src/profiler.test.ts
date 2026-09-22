import { describe, expect, it } from "vite-plus/test";

import { GpuProfiler } from "./profiler";

function timerDevice() {
  let ready = false;
  let disjoint = false;
  let created = 0;
  let reads = 0;
  const deleted: object[] = [];

  const gl = {
    QUERY_RESULT_AVAILABLE: 1,
    QUERY_RESULT: 2,
    getExtension: () => ({ TIME_ELAPSED_EXT: 3, GPU_DISJOINT_EXT: 4 }),
    getParameter: () => disjoint,
    createQuery: () => ({ index: created++ }),
    beginQuery: () => {},
    endQuery: () => {},
    deleteQuery: (query: object) => deleted.push(query),
    getQueryParameter: (_query: object, property: number) => {
      if (property === 1) return ready;
      reads++;

      return 2_500_000;
    },
  } as unknown as WebGL2RenderingContext;

  return {
    gl,
    ready: () => {
      ready = true;
    },
    disjoint: () => {
      disjoint = true;
    },
    counts: () => ({ created, reads, deleted: deleted.length }),
  };
}

describe("nonblocking GPU profiling", () => {
  it("never reads unfinished query results and bounds pending GPU work", () => {
    const { gl, ready, counts } = timerDevice();
    const profiler = new GpuProfiler(gl, true);

    for (let i = 0; i < 20; i++) {
      profiler.begin();
      profiler.end();
    }

    expect(counts()).toEqual({ created: 4, reads: 0, deleted: 0 });
    expect(profiler.milliseconds).toBeNull();
    ready();
    profiler.begin();
    expect(profiler.milliseconds).toBe(2.5);
    expect(profiler.samples).toBe(4);
    profiler.destroy();
    expect(counts().deleted).toBe(5);
  });

  it("discards timings when the driver reports a disjoint clock", () => {
    const { gl, disjoint, counts } = timerDevice();
    const profiler = new GpuProfiler(gl, true);
    profiler.begin();
    profiler.end();
    disjoint();
    profiler.begin();
    expect(profiler.milliseconds).toBeNull();
    expect(profiler.samples).toBe(0);
    expect(counts()).toEqual({ created: 1, reads: 0, deleted: 1 });
    profiler.destroy();
  });
});
