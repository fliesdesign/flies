type TimerExtension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

/** Nonblocking GPU timings; completed values describe an earlier submitted frame. */
export class GpuProfiler {
  private readonly extension: TimerExtension | null;
  private readonly pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  milliseconds: number | null = null;
  samples = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly enabled: boolean,
  ) {
    this.extension = enabled ? gl.getExtension("EXT_disjoint_timer_query_webgl2") : null;
  }

  get supported() {
    return Boolean(this.extension);
  }

  begin() {
    this.end();
    const extension = this.extension;
    if (!this.enabled || !extension) return;
    const gl = this.gl;

    if (gl.getParameter(extension.GPU_DISJOINT_EXT)) {
      for (const query of this.pending) gl.deleteQuery(query);
      this.pending.length = 0;
      this.milliseconds = null;

      return;
    }

    while (
      this.pending.length &&
      gl.getQueryParameter(this.pending[0], gl.QUERY_RESULT_AVAILABLE)
    ) {
      const query = this.pending.shift()!;
      this.milliseconds = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1_000_000;
      this.samples++;
      gl.deleteQuery(query);
    }

    if (this.pending.length >= 4) return;
    this.active = gl.createQuery();
    if (this.active) gl.beginQuery(extension.TIME_ELAPSED_EXT, this.active);
  }

  end() {
    if (!this.active || !this.extension) return;
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  destroy() {
    this.end();
    for (const query of this.pending) this.gl.deleteQuery(query);
    this.pending.length = 0;
  }
}
