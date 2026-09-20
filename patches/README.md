# PixiJS 8.21.0 resource cleanup

`pixi.js@8.21.0.patch` fixes two WebGPU binding ownership issues:

- The process-wide texture batch cache kept bind groups subscribed to destroyed
  texture sources and samplers. Its cache-owned groups now evict themselves and
  release every binding when a resource is destroyed. Ordinary shader bind groups
  retain Pixi's warning and validation behavior.
- `FilterSystem.destroy()` did not release its global filter bind group. The patch
  makes that cleanup complete and idempotent. Flies calls it before renderer pipe
  teardown, which destroys the uniform-batch buffers referenced by filters.

Both ESM and CommonJS builds are patched. Bun applies this automatically through
`patchedDependencies`; Docker copies the patches before dependency installation.

Run `bun run test:gpu` when updating Pixi. The textured-artwork lifecycle regression
covers repeated shadow/text replacement, image deletion, and renderer disposal,
asserting that rendering remains active and no Pixi warnings or page errors occur.
Remove the patch only when these paths pass against an upstream release.
