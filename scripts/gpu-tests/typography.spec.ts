import { expect, test } from "@playwright/test";

for (const { name, width, fontSize } of [
  { name: "desktop", width: 800, fontSize: 64 },
  { name: "mobile", width: 340, fontSize: 38 },
]) {
  test(`negative letter spacing preserves every imported heading fragment on ${name}`, async ({
    page,
  }, testInfo) => {
    await page.goto("/");

    const regions = await page.evaluate(
      async ({ layoutWidth, size }) => {
        const harnessPath = "/scripts/gpu-tests/gpu-harness.tsx";
        const htmlPath = "/packages/html/src/html.ts";
        const { mountGpuFixture } = await import(/* @vite-ignore */ harnessPath);
        const { importHtml } = await import(/* @vite-ignore */ htmlPath);
        const fixture = await mountGpuFixture();
        Reflect.set(window, "gpuFixture", fixture);

        const nodes = await importHtml(
          `<main style="width:${layoutWidth}px;height:500px;background:white"><h1 style="font-family:Arial;font-size:${size}px;line-height:1.1;font-weight:400;letter-spacing:-2px">I make product interfaces <span style="color:#666">that stay out of the way.</span></h1></main>`,
          { x: 40, y: 60, width: layoutWidth },
        );

        nodes.push({
          id: "wrapping-paragraph",
          parentId: nodes[0].id,
          name: "Wrapping paragraph",
          kind: "text",
          text: "Alpha beta gamma delta epsilon",
          x: 40,
          y: 350,
          width: 200,
          height: 160,
          fontFamily: "Arial",
          fontSize: 32,
          fontWeight: 400,
          letterSpacing: -2,
          lineHeight: 1.25,
          color: "#000000",
        });
        fixture.controls.document.transact({
          remove: fixture.controls.document.getIds(),
          add: nodes,
        });

        return nodes
          .filter((node) => node.kind === "text")
          .map((node) => {
            // Locate the last letter using browser geometry. If Pixi rewraps a
            // measured line, that letter falls below its one-line clipping box.
            const text = document.createElement("span");
            Object.assign(text.style, {
              position: "fixed",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              width: `${node.width}px`,
              fontFamily: "Arial",
              fontSize: `${node.fontSize}px`,
              fontWeight: "400",
              letterSpacing: "-2px",
              lineHeight: String(node.lineHeight),
            });
            text.textContent = node.text;
            document.body.append(text);
            const lastLetter = node.text.search(/[a-z][^a-z]*$/i);
            const range = document.createRange();
            range.setStart(text.firstChild!, lastLetter);
            range.setEnd(text.firstChild!, lastLetter + 1);
            const letter = range.getBoundingClientRect();
            const whole = text.getBoundingClientRect();
            text.remove();
            const lineHeight = node.fontSize * node.lineHeight;
            const line = Math.round((letter.y - whole.y) / lineHeight);

            return {
              text: node.text,
              x: Math.ceil(node.x + letter.x - whole.x),
              y: Math.ceil(node.y + line * lineHeight),
              width: Math.max(1, Math.floor(letter.width)),
              height: Math.floor(lineHeight),
            };
          });
      },
      { layoutWidth: width, size: fontSize },
    );

    const artwork = page.locator("[data-gpu-fixture] .canvas-gpu-surface[data-renderer=webgpu]");
    await expect(artwork).toBeVisible();
    await expect
      .poll(async () => {
        const screenshot = await page.locator("[data-gpu-fixture]").screenshot();

        return page.evaluate(
          async ({ png, samples }) => {
            const image = new Image();
            image.src = `data:image/png;base64,${png}`;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext("2d")!;
            context.drawImage(image, 0, 0);

            return samples.map((sample) => {
              const pixels = context.getImageData(
                sample.x,
                sample.y,
                sample.width,
                sample.height,
              ).data;

              let ink = 0;
              for (let index = 0; index < pixels.length; index += 4)
                if (Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) < 170) ink++;

              return { text: sample.text, visible: ink > 5 };
            });
          },
          { png: screenshot.toString("base64"), samples: regions },
        );
      })
      .toEqual(regions.map(({ text }) => ({ text, visible: true })));

    await testInfo.attach(`${name}-heading-webgpu.png`, {
      body: await page.locator("[data-gpu-fixture]").screenshot(),
      contentType: "image/png",
    });
  });
}
