import { readFileSync } from "node:fs";

import { initSync } from "@swc/wasm-web";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { jsxToHtml } from "./jsx";
import { detectSourceFormat, unwrapSource } from "./source";

describe("static JSX conversion", () => {
  beforeAll(() => {
    initSync({
      module: readFileSync(new URL("../node_modules/@swc/wasm-web/wasm_bg.wasm", import.meta.url)),
    });
  });
  it("converts a TSX module with local components, props, map and style objects", async () => {
    const result = await jsxToHtml(`
      import React from 'react';
      type Props = { title: string; active?: boolean };
      const items = ['One', 'Two'];
      function Card({title, active = false}: Props) {
        return <p className={active ? 'font-bold' : 'font-normal'}
          style={{paddingTop: 12, lineHeight: 1.5, opacity: 0.8}}>{title}</p>;
      }
      export default function App() {
        return <section data-name="Cards">{items.map((title, i) =>
          <Card key={i} title={title} active={i === 0} />)}</section>;
      }
    `);

    expect(result.html).toBe(
      '<section data-name="Cards"><p class="font-bold" style="padding-top:12px;line-height:1.5;opacity:0.8">One</p><p class="font-normal" style="padding-top:12px;line-height:1.5;opacity:0.8">Two</p></section>',
    );
    expect(result.warnings).toEqual([]);
  });

  it("handles fragments, rest props, children, helpers and conditional returns", async () => {
    const { html } = await jsxToHtml(`
      const label = (value: string) => \`Hello \${value}\`;
      function Box({children, ...rest}) { return <div {...rest}>{children}</div>; }
      const App = () => {
        const ready = true;
        if (!ready) return null;
        return <><Box className="p-4">{label('World')}</Box><p>{false}{null}{0}</p></>;
      };
    `);

    expect(html).toBe('<div class="p-4">Hello World</div><p>0</p>');
  });

  it("escapes text and attributes and omits handlers without evaluating them", async () => {
    const { html, warnings } = await jsxToHtml(
      `<button title={'"<>&'} onClick={window.attack()} ref={unknownRef}>{'<script>bad()</script>'}</button>`,
    );

    expect(html).toBe(
      '<button title="&quot;&lt;&gt;&amp;">&lt;script&gt;bad()&lt;/script&gt;</button>',
    );
    expect(warnings).toEqual(["Event handlers and refs were omitted from the static design."]);
  });

  it("converts SVG attributes and preserves case-sensitive names", async () => {
    expect(
      (
        await jsxToHtml(
          '<svg viewBox="0 0 24 24"><path strokeWidth={2} strokeLinecap="round" d="M0 0h24" /></svg>',
        )
      ).html,
    ).toBe(
      '<svg viewBox="0 0 24 24"><path stroke-width="2" stroke-linecap="round" d="M0 0h24"></path></svg>',
    );
  });

  it("preserves TS assertions, computed keys, optional members and named default exports", async () => {
    const { html } = await jsxToHtml(`
      "use client";
      const key = 'text';
      const data = ({[key]: 'Hello'} satisfies Record<string, string>);
      const empty = null;
      const App = () => <p>{empty?.label ?? (data![key] as string)}{false && missing()}</p>;
      export { App as default };
    `);

    expect(html).toBe("<p>Hello</p>");
  });

  it("handles standalone return snippets and rejects malformed JSX with a useful error", async () => {
    expect((await jsxToHtml("return <p>Snippet</p>;")).html).toBe("<p>Snippet</p>");
    await expect(jsxToHtml("<div><span></div>")).rejects.toThrow(/Invalid JSX\/TSX/);
  });

  it.each([
    [
      "export default function App() { const [x] = useState(1); return <p>{x}</p>; }",
      /Unknown value useState/,
    ],
    [
      'import { Button } from "kit"; export default () => <Button/>;',
      /Component Button is not defined/,
    ],
    ["<p>{window.location}</p>", /Unknown value window/],
    ["<p>{({}).constructor}</p>", /Unsupported property: constructor/],
    ['<p>{fetch("https://example.com")}</p>', /Unknown value fetch/],
    ['<div dangerouslySetInnerHTML={{__html: "bad"}}/>', /dangerouslySetInnerHTML/],
    ["function App(){ return <App/>; }", /nesting is limited/],
    [
      "const x = {get value(){return 1}}; export default () => <p>{x.value}</p>",
      /Object methods and getters/,
    ],
    ["function App(){ while(true){} return <p/>; }", /Unsupported component statement/],
    ['<p>{new Function("return 1")()}</p>', /Unsupported expression/],
  ])("rejects unsupported executable input: %s", async (source, message) => {
    await expect(jsxToHtml(source)).rejects.toThrow(message);
  });

  it("bounds output growth, array expansion and source size", async () => {
    const doubled =
      'const a0 = "xxxxxxxxxx";' +
      Array.from({ length: 20 }, (_, i) => `const a${i + 1} = a${i} + a${i};`).join("");

    await expect(jsxToHtml(`${doubled} export default () => <p>{a20}</p>`)).rejects.toThrow(
      /200KB/,
    );

    const arrays =
      "const a0 = [1];" +
      Array.from({ length: 10 }, (_, i) => `const a${i + 1} = [...a${i}, ...a${i}];`).join("");

    await expect(jsxToHtml(`${arrays} export default () => <p>{a10}</p>`)).rejects.toThrow(
      /500 items/,
    );
    await expect(jsxToHtml(`<p>${"x".repeat(200_000)}</p>`)).rejects.toThrow(/200KB/);
  });
});

describe("clipboard source detection", () => {
  it.each([
    ["<div>Hello</div>", "html"],
    ['<div className="p-4">Hello</div>', "jsx"],
    ['<p>{"hello"}</p>', "jsx"],
    ["<>Hi</>", "jsx"],
    ["export default () => <p>Hello</p>", "jsx"],
    ['// Card\n"use client";\ninterface Props {}\nexport default () => <p/>', "jsx"],
    ["```tsx\nconst App = () => <p/>;\n```", "jsx"],
    ["```html\n<p>Hello</p>\n```", "html"],
    ["A plain text note about React", undefined],
    ["Please use <div> for this", undefined],
  ])("detects %s", (source, format) => expect(detectSourceFormat(source)).toBe(format));

  it("unwraps only complete fences", () => {
    expect(unwrapSource("```jsx\n<p/>\n```")).toEqual({ source: "<p/>", language: "jsx" });
    expect(unwrapSource("before\n```html\n<p/>\n```").source).toContain("before");
  });
});
