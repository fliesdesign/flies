# Design system

## Dark theme

The original component foundation was adapted from [OpenAI Platform — UI Kit in Paper](https://app.paper.design/file/01M25GA8KKM41CKAZ2FHEP016Y/1-0),
Default page. The editor now uses its own palette and control treatment rather than reproducing
that kit. Theme tokens live in `apps/web/src/styles.css`. The neutral theme is dark-only:
`apps/web/index.html` sets the `dark` class before rendering, and CSS declares `color-scheme: dark`
independently of OS settings.

- Canvas `#181818`, panels `#222222`, recessed fields `#1A1A1A`, menus `#292929`.
- Text `#E8E8E8`, muted text `#A3A3A3`, neutral focus and guide lines `#BCBCBC`.
- Compact toolbar and selected layers use simple gray active states.
- System UI typography for the editor and SF Mono/Consolas numeric fields, with no remote font requests.
- 14/20 px controls, 16/20 px card titles, 20/32 px section headings, 36/44 px page titles.
- 6–8 px control radii, 12 px menus, 16 px cards; cards/dialogs use 20 px insets.
- Controls use 150 ms transitions, navigation 200 ms, tooltips 250 ms. Search uses
  `cubic-bezier(0.19, 1, 0.22, 1)`. Menus open directly, as observed in the kit.
- Card action layers reveal from opacity 0 / scale .98 on hover or keyboard focus; touch devices
  keep the actions visible. Use the `oui-card-reveal*` classes shown in the component preview.
- Spinner: thin rounded arc, 1.2 s rotation / 1.5 s arc cycle. These timings are reconstructed in
  the source kit. Dialog/toast/drawer motion and chart colors are companion adaptations, not
  measured reproductions. Reduced motion removes movement and keeps loading indicators visible.
- `Badge` adds `new` and `subtle` variants; `Alert` adds `warning`. Existing component APIs remain.

## UI components

The full shadcn registry is already installed in `apps/web/src/components/ui` — 61 components. They
are yours to edit. Unused ones are tree-shaken out of the JS bundle, but Tailwind still scans them
for class names, so deleting components you never use will shrink the CSS.

Re-sync or add later with `bun x shadcn@latest add <name>`. They are built on
[Base UI](https://base-ui.com) (`@base-ui/react`), not Radix — check Base UI's docs when a
component's props differ from shadcn examples you find online. Icons are `lucide-react`; the editor
uses native system typography with monospaced numeric fields. Canvas text retains its own font
settings. No proprietary font files or remote font requests are required.

All 61 component modules inherit the shared color, type, radius, and motion tokens. Controls, menus,
overlays, selection, feedback, navigation, and message components also have explicit style
adjustments; layout-only primitives keep their behavior. Open `/components` to inspect
representative controls and interactive states; the preview uses local in-memory sample data.
Registry regeneration can overwrite the custom theme adjustments — review generated changes rather
than blindly replacing customized components.
