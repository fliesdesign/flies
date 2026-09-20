/** Keeps a stationary drag over a collapsed container from restarting its hover delay. */
export class LayerHoverExpansion {
  private target: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly delay = 600) {}

  update(target: string | null, expand: (id: string) => void) {
    if (target === this.target) return;
    this.cancel();
    this.target = target;
    if (target === null) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      expand(target);
    }, this.delay);
  }

  cancel() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.target = null;
  }
}
