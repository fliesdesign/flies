/* oxlint-disable oxc/no-map-spread -- Each gradient fixture needs an independent node. */
import type { CanvasFrame } from "@flies/canvas";
import { test, expect, type Page } from "@playwright/test";

async function mount(page: Page, nodes: CanvasFrame[]) {
  await page.goto("/recents");
  await page.evaluate(async (frames) => {
    const path = "/scripts/gpu-tests/gpu-harness.tsx";
    const { mountGpuFixture } = await import(/* @vite-ignore */ path);
    const fixture = await mountGpuFixture();
    Reflect.set(window, "paintFixture", fixture);
    const doc = fixture.controls.document;
    if (!doc.transact({ remove: [...doc.getIds()], add: frames }))
      throw new Error("Fixture rejected");
  }, nodes);
  await expect(page.locator(".canvas-webgl-surface[data-renderer=webgl2]")).toBeVisible();
}

async function samples(page: Page, points: { x: number; y: number }[]) {
  const screenshot = await page.locator("[data-gpu-fixture]").screenshot();

  return page.evaluate(
    async ({ png, points: locations }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);

      return locations.map((p) => Array.from(ctx.getImageData(p.x, p.y, 1, 1).data));
    },
    { png: screenshot.toString("base64"), points },
  );
}

async function dom(page: Page) {
  await page.evaluate(() => Reflect.get(window, "paintFixture").setInspection(true));
  await expect(page.locator(".canvas-webgl-surface")).toHaveCount(0);
}

const rect = (id: string, x: number, y: number, width = 120, height = 80): CanvasFrame => ({
  id,
  name: id,
  kind: "rectangle",
  x,
  y,
  width,
  height,
  fill: "#ff0000",
});

test("gradient angles and radial fills match DOM colors in WebGL2", async ({ page }) => {
  const angles = [0, 45, 90, 135, 180, 225, 270, 315];

  const nodes = angles.map((angle, i) => ({
    ...rect(`gradient-${i}`, 100 + (i % 4) * 240, 100 + Math.floor(i / 4) * 200, 160, 90),
    gradient: {
      type: "linear" as const,
      angle,
      stops: [
        { offset: 0, color: "#ff0000" },
        { offset: 0.4, color: "#00ff0080" },
        { offset: 1, color: "#0000ff" },
      ],
    },
  }));

  nodes.push({
    ...rect("radial", 100, 500, 160, 90),
    gradient: {
      type: "radial" as "linear",
      angle: 0,
      stops: [
        { offset: 0, color: "#ff0000" },
        { offset: 1, color: "#0000ff" },
      ],
    },
  });

  const points = nodes.flatMap((node) => [
    { x: node.x + 20, y: node.y + 20 },
    { x: node.x + 80, y: node.y + 45 },
    { x: node.x + 140, y: node.y + 70 },
  ]);

  await mount(page, nodes);
  const gpu = await samples(page, points);
  await dom(page);
  const html = await samples(page, points);
  for (let i = 0; i < gpu.length; i++)
    for (let c = 0; c < 3; c++)
      expect(
        Math.abs(gpu[i][c] - html[i][c]),
        `sample ${i}, channel ${c}: gpu ${gpu[i]} DOM ${html[i]}`,
      ).toBeLessThanOrEqual(5);
});

test("whole-layer blend modes preserve translucent overlap and match DOM", async ({ page }) => {
  const modes = [
    "multiply",
    "screen",
    "overlay",
    "darken",
    "lighten",
    "color-dodge",
    "color-burn",
    "hard-light",
    "soft-light",
    "difference",
    "exclusion",
    "hue",
    "saturation",
    "color",
    "luminosity",
  ] as const;

  const nodes: CanvasFrame[] = [];
  const points: { x: number; y: number }[] = [];
  modes.forEach((blendMode, i) => {
    const x = 100 + (i % 5) * 210,
      y = 70 + Math.floor(i / 5) * 170;

    nodes.push({ ...rect(`base-${i}`, x, y, 160, 120), fill: "#4a8cb6" });
    nodes.push({
      id: `group-${i}`,
      name: blendMode,
      kind: "group",
      x: x + 10,
      y: y + 10,
      width: 130,
      height: 90,
      blendMode,
      opacity: 0.65,
    });
    nodes.push({
      ...rect(`first-${i}`, x + 10, y + 10, 90, 90),
      parentId: `group-${i}`,
      fill: "#dd8342",
    });
    nodes.push({
      ...rect(`second-${i}`, x + 50, y + 10, 90, 90),
      parentId: `group-${i}`,
      fill: "#68bf93",
    });
    points.push({ x: x + 30, y: y + 40 }, { x: x + 70, y: y + 40 }, { x: x + 120, y: y + 40 });
  });
  await mount(page, nodes);
  const gpu = await samples(page, points);
  await dom(page);
  const html = await samples(page, points);
  for (let i = 0; i < gpu.length; i++)
    for (let c = 0; c < 3; c++)
      expect(
        Math.abs(gpu[i][c] - html[i][c]),
        `${modes[Math.floor(i / 3)]} pixel ${i}: GPU ${gpu[i]} DOM ${html[i]}`,
      ).toBeLessThanOrEqual(5);
});

test("color filters and nested rotation match DOM; rotated picking uses painted coordinates", async ({
  page,
}) => {
  const nodes: CanvasFrame[] = [
    {
      id: "rotated",
      name: "Rotated",
      x: 120,
      y: 100,
      width: 240,
      height: 180,
      rotation: 35,
      fill: "#fff",
      cornerRadius: 24,
    },
    {
      ...rect("rotated-child", 160, 120, 200, 80),
      parentId: "rotated",
      rotation: -20,
      fill: "#24aaff",
      filters: { brightness: 1.2, contrast: 0.8, saturate: 0.4, hue: 35 },
    },
    {
      ...rect("filtered", 600, 100),
      fill: "#24aaff",
      filters: { grayscale: 0.2, sepia: 0.7, invert: 0.4 },
    },
  ];

  await mount(page, nodes);

  const points = [
    { x: 220, y: 150 },
    { x: 260, y: 170 },
    { x: 620, y: 130 },
    { x: 290, y: 100 },
  ];

  const gpu = await samples(page, points);
  await dom(page);
  const html = await samples(page, points);
  for (let i = 0; i < gpu.length; i++)
    for (let c = 0; c < 3; c++)
      expect(
        Math.abs(gpu[i][c] - html[i][c]),
        `sample ${i}: GPU ${gpu[i]} DOM ${html[i]}`,
      ).toBeLessThanOrEqual(5);

  const hit = await page.evaluate(async () => {
    const path = "/packages/canvas/src/index.ts";

    const { CanvasHitTester, worldTransform, transformPoint } = await import(
      /* @vite-ignore */ path
    );

    const doc = Reflect.get(window, "paintFixture").controls.document;
    const child = doc.getFrame("rotated-child");
    const p = transformPoint(worldTransform(doc, child), { x: 60, y: 30 });

    return new CanvasHitTester(doc).hit(p);
  });

  expect(hit).toBe("rotated-child");
});

for (const zoom of [0.5, 1, 2])
  test(`blur matches CSS falloff at zoom ${zoom}`, async ({ page }) => {
    const nodes: CanvasFrame[] = [
      { ...rect("blurred", 250, 150, 180, 120), fill: "#ffffff", filters: { blur: 8 } },
    ];

    await mount(page, nodes);

    await page.evaluate((value) => {
      const camera = Reflect.get(window, "paintFixture").controls.camera;
      camera.setViewport({ x: 0, y: 0, zoom: value });
      camera.flush();
    }, zoom);

    const points = [
      { x: 238, y: 200 },
      { x: 246, y: 200 },
      { x: 250, y: 200 },
      { x: 254, y: 200 },
      { x: 262, y: 200 },
      { x: 280, y: 200 },
    ].map((p) => ({ x: p.x * zoom, y: p.y * zoom }));

    const gpu = await samples(page, points);
    await dom(page);
    const html = await samples(page, points);
    for (let i = 0; i < gpu.length; i++)
      expect(
        Math.abs(gpu[i][0] - html[i][0]),
        `blur ${i}: GPU ${gpu[i]} DOM ${html[i]}`,
      ).toBeLessThanOrEqual(8);
  });

test("Oklab interpolation, gradient backgrounds and imported filter order match DOM", async ({
  page,
}) => {
  const nodes: CanvasFrame[] = [
    {
      ...rect("oklab", 100, 100, 240, 180),
      gradient: {
        type: "linear",
        angle: 120,
        interpolation: "oklab",
        background: "#ccddaa",
        stops: [
          { offset: 0, color: "#ff000080" },
          { offset: 0.4, color: "#00ff00aa" },
          { offset: 1, color: "#0000ff" },
        ],
      },
    },
    {
      ...rect("ordered", 400, 100, 240, 180),
      fill: "#996633",
      filters: {
        brightness: 0.6,
        contrast: 0.3,
        invert: 0.3,
        order: ["invert", "contrast", "brightness"],
      },
    },
  ];

  await mount(page, nodes);

  const points = [
    { x: 125, y: 125 },
    { x: 210, y: 190 },
    { x: 315, y: 255 },
    { x: 520, y: 190 },
  ];

  const gpu = await samples(page, points);
  await dom(page);
  const html = await samples(page, points);
  for (let i = 0; i < points.length; i++)
    for (let c = 0; c < 3; c++)
      expect(
        Math.abs(gpu[i][c] - html[i][c]),
        `sample ${i}: GPU ${gpu[i]} HTML ${html[i]}`,
      ).toBeLessThanOrEqual(5);
});
