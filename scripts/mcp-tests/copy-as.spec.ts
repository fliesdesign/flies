/* eslint-disable no-await-in-loop -- Menu actions share a page and clipboard, so must run sequentially. */
import { expect, test } from "@playwright/test";

test("Copy as offers four working clipboard exports and disables without a selection", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/scripts/mcp-tests/paper-snapshot-harness.tsx";
    const fixture = await (await import(/* @vite-ignore */ path)).mountSnapshotFixture();
    Reflect.set(window, "copyFixture", fixture);
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async (text: string) => Reflect.set(window, "copiedCode", text),
    });
  });
  await page
    .locator("[data-snapshot-fixture] .design-canvas")
    .click({ button: "right", position: { x: 500, y: 300 } });
  await expect(page.getByRole("menuitem", { name: "Copy as", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const fixture = Reflect.get(window, "copyFixture");
    fixture.controls.document.addMany([
      { id: "frame", name: "Copy card", x: 100, y: 100, width: 240, height: 160, fill: "#123456" },
      {
        id: "text",
        parentId: "frame",
        name: "Label",
        kind: "text",
        x: 120,
        y: 120,
        width: 180,
        height: 30,
        text: "Hello",
        fontSize: 20,
        color: "#ffffff",
      },
    ]);
    fixture.controls.select("frame");
  });

  for (const format of ["Tailwind", "CSS", "React Tailwind", "React CSS"]) {
    await page
      .locator("[data-snapshot-fixture] .design-canvas")
      .click({ button: "right", position: { x: 300, y: 230 } });
    await page.getByRole("menuitem", { name: "Copy as", exact: true }).hover();
    await page.getByRole("menuitem", { name: format, exact: true }).click();
    const copied = await page.evaluate(() => Reflect.get(window, "copiedCode") as string);
    expect(copied).toContain("Hello");
    expect(copied.includes("export default function")).toBe(format.startsWith("React"));
    expect(copied.includes("w-[240px]")).toBe(format.includes("Tailwind"));
    await expect(page.getByText(`Copied as ${format}.`, { exact: true })).toBeVisible();
  }
});

test("CSS and compiled Tailwind exports render matching selection geometry and appearance", async ({
  page,
}) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const exporterPath = "/src/lib/canvas-code-export.ts",
      compilerPath = "/src/lib/mcp/tailwind.ts";

    const { exportCanvasCode } = await import(/* @vite-ignore */ exporterPath);
    const { compileTailwind } = await import(/* @vite-ignore */ compilerPath);

    const nodes = [
      {
        id: "frame",
        name: "Card",
        x: 50,
        y: 70,
        width: 240,
        height: 160,
        fill: "#123456",
        borderWidth: 2,
        borderColor: "#ffffff",
        opacity: 0.8,
      },
      {
        id: "text",
        parentId: "frame",
        name: "Label",
        kind: "text",
        x: 70,
        y: 90,
        width: 180,
        height: 30,
        text: "Hello\nWorld",
        fontSize: 20,
        color: "#ffffff",
        fontFamily: "Courier New",
      },
    ];

    const measure = async (format: string) => {
      const template = document.createElement("template");
      template.innerHTML = exportCanvasCode(nodes, ["frame"], format);
      const css = format === "Tailwind" ? await compileTailwind(template.content) : "";
      const iframe = document.createElement("iframe");
      document.body.append(iframe);
      const doc = iframe.contentDocument!;
      const style = doc.createElement("style");
      style.textContent = css ?? "";
      doc.head.append(style);
      doc.body.style.margin = "0";
      doc.body.append(template.content);
      const card = doc.querySelector<HTMLElement>('[data-name="Card"]')!;
      const label = doc.querySelector<HTMLElement>('[data-name="Label"]')!;
      const text = label.querySelector("span")!;

      const cardStyle = getComputedStyle(card),
        textStyle = getComputedStyle(text);

      const geometry = {
        x: label.getBoundingClientRect().x,
        y: label.getBoundingClientRect().y,
        width: card.getBoundingClientRect().width,
        height: card.getBoundingClientRect().height,
        fill: cardStyle.backgroundColor,
        opacity: cardStyle.opacity,
        font: textStyle.fontFamily,
        fontSize: textStyle.fontSize,
        color: textStyle.color,
        whitespace: textStyle.whiteSpace,
        border: getComputedStyle(card.lastElementChild!).borderWidth,
      };

      iframe.remove();

      return geometry;
    };

    return { css: await measure("CSS"), tailwind: await measure("Tailwind") };
  });

  expect(result.tailwind).toEqual(result.css);
  expect(result.css).toMatchObject({
    x: 20,
    y: 20,
    width: 240,
    height: 160,
    fill: "rgb(18, 52, 86)",
    opacity: "0.8",
    fontSize: "20px",
    color: "rgb(255, 255, 255)",
    whitespace: "pre-wrap",
    border: "2px",
  });
});
