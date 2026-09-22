import {
  appendCanvasText,
  canvasTextRunCss,
  canvasTextSegments,
  editCanvasTextRuns,
  formatCanvasTextRange,
  isCanvasTextLink,
  type CanvasText,
  type CanvasTextContent,
  type CanvasTextRun,
  type CanvasTextRunStyle,
} from "@flies/canvas";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  canvasTextStyle,
  measureCanvasTextHeight,
  subscribeTextDraftLifecycle,
} from "./canvas-node-content";

export type CanvasTextCommit = (
  id: string,
  text: string,
  height: number,
  textRuns?: readonly CanvasTextRun[],
) => void;
type SelectionOffsets = { start: number; end: number };

function selectionOffsets(element: HTMLElement): SelectionOffsets | undefined {
  const selection = element.ownerDocument.getSelection();
  if (
    !selection?.rangeCount ||
    !element.contains(selection.anchorNode) ||
    !element.contains(selection.focusNode)
  )
    return;
  const range = selection.getRangeAt(0);
  const before = range.cloneRange();
  before.selectNodeContents(element);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;

  return { start, end: start + range.toString().length };
}

function restoreSelection(element: HTMLElement, offsets: SelectionOffsets) {
  const doc = element.ownerDocument;
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();

  let cursor = 0,
    startSet = false;

  let node = walker.nextNode();

  while (node) {
    const length = node.textContent?.length ?? 0;

    if (!startSet && offsets.start <= cursor + length) {
      range.setStart(node, Math.max(0, offsets.start - cursor));
      startSet = true;
    }

    if (offsets.end <= cursor + length) {
      range.setEnd(node, Math.max(0, offsets.end - cursor));
      break;
    }

    cursor += length;
    node = walker.nextNode();
  }

  if (!startSet) {
    range.selectNodeContents(element);
    range.collapse(false);
  }

  const selection = doc.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function CanvasRichTextEditor({
  frame,
  onCommit,
  onCancel,
}: {
  frame: CanvasText;
  onCommit?: CanvasTextCommit;
  onCancel?: (id: string) => void;
}) {
  const input = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const draft = useRef<CanvasTextContent>({ text: frame.text, textRuns: frame.textRuns });
  const selection = useRef<SelectionOffsets>({ start: 0, end: frame.text.length });
  const finished = useRef(false);
  const composing = useRef(false);
  const undo = useRef<CanvasTextContent[]>([]);
  const redo = useRef<CanvasTextContent[]>([]);
  const [position, setPosition] = useState<{ x: number; y: number }>();
  const [selected, setSelected] = useState(false);
  const [link, setLink] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [error, setError] = useState("");

  const [initialContent] = useState(() =>
    canvasTextSegments(frame).map((segment) => (
      <span key={segment.start} style={canvasTextRunCss(segment.style)}>
        {segment.text}
      </span>
    )),
  );

  const resize = useCallback(() => {
    const height = measureCanvasTextHeight({ ...frame, ...draft.current });
    if (input.current) input.current.style.height = `${height}px`;

    return height;
  }, [frame]);

  const write = useCallback(
    (content: CanvasTextContent, offsets = selection.current) => {
      draft.current = content;
      const element = input.current;
      if (!element) return;
      element.replaceChildren();
      appendCanvasText(element, content);
      element.focus({ preventScroll: true });

      const clamped = {
        start: Math.min(offsets.start, content.text.length),
        end: Math.min(offsets.end, content.text.length),
      };

      restoreSelection(element, clamped);
      selection.current = clamped;
      resize();
    },
    [resize],
  );

  const remember = () => {
    undo.current.push(draft.current);
    if (undo.current.length > 100) undo.current.shift();
    redo.current = [];
  };

  const commit = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    onCommit?.(frame.id, draft.current.text, resize(), draft.current.textRuns);
  }, [frame.id, onCommit, resize]);

  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    restoreSelection(element, selection.current);
  }, []);

  useLayoutEffect(() => {
    resize();
  }, [resize]);

  useEffect(() => subscribeTextDraftLifecycle(commit, window, document), [commit]);

  useEffect(() => {
    const update = () => {
      const element = input.current;
      if (!element) return;
      const offsets = selectionOffsets(element);
      if (offsets) selection.current = offsets;
      setSelected(selection.current.end > selection.current.start);
      const rect = element.getBoundingClientRect();
      setPosition({
        x: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 400)),
        y: Math.max(8, rect.top - 44),
      });
    };

    update();
    document.addEventListener("selectionchange", update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);

    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, []);

  function format(patch: { [K in keyof CanvasTextRunStyle]?: CanvasTextRunStyle[K] | null }) {
    if (selection.current.start === selection.current.end) return;
    remember();
    write({
      ...draft.current,
      textRuns: formatCanvasTextRange(
        draft.current,
        selection.current.start,
        selection.current.end,
        patch,
      ),
    });
  }

  function toggle(
    key: "fontWeight" | "fontStyle" | "textDecoration",
    on: 700 | "italic" | "underline",
  ) {
    const runs = canvasTextSegments(draft.current).filter(
      (run) => run.end > selection.current.start && run.start < selection.current.end,
    );

    const active = runs.length > 0 && runs.every((run) => (run.style[key] ?? frame[key]) === on);
    format({
      [key]: active ? (key === "fontWeight" ? 400 : key === "fontStyle" ? "normal" : "none") : on,
    });
  }

  function readInput() {
    const text = input.current?.textContent ?? "";
    if (text === draft.current.text) return;
    if (!composing.current) remember();
    draft.current = { text, textRuns: editCanvasTextRuns(draft.current, text) };
    selection.current = selectionOffsets(input.current!) ?? {
      start: text.length,
      end: text.length,
    };
    resize();
  }

  function insertText(text: string) {
    const { start, end } = selectionOffsets(input.current!) ?? selection.current;
    const next = draft.current.text.slice(0, start) + text + draft.current.text.slice(end);
    remember();
    write(
      { text: next, textRuns: editCanvasTextRuns(draft.current, next) },
      { start: start + text.length, end: start + text.length },
    );
  }

  return (
    <>
      <div
        ref={input}
        className="canvas-text-editor"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- Rich text requires contenteditable spans; textarea cannot represent formatting.
        role="textbox"
        tabIndex={0}
        aria-label={`Edit ${frame.name}`}
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        style={canvasTextStyle(frame)}
        onInput={readInput}
        onCompositionStart={() => {
          remember();
          composing.current = true;
        }}
        onCompositionEnd={() => {
          readInput();
          composing.current = false;
        }}
        onBeforeInput={(event) => {
          const type = (event.nativeEvent as InputEvent).inputType;

          if (type === "insertParagraph" || type === "insertLineBreak") {
            event.preventDefault();
            insertText("\n");
          }
        }}
        onPaste={(event) => {
          event.preventDefault();
          event.stopPropagation();
          insertText(event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n"));
        }}
        onBlur={(event) => {
          if (!toolbar.current?.contains(event.relatedTarget as Node | null)) commit();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          const modifier = event.metaKey || event.ctrlKey;

          if (modifier && ["b", "i", "u"].includes(event.key.toLowerCase())) {
            event.preventDefault();
            if (event.key.toLowerCase() === "b") toggle("fontWeight", 700);
            else if (event.key.toLowerCase() === "i") toggle("fontStyle", "italic");
            else toggle("textDecoration", "underline");

            return;
          }

          if (modifier && event.key.toLowerCase() === "z") {
            event.preventDefault();
            const source = event.shiftKey ? redo.current : undo.current;
            const target = event.shiftKey ? undo.current : redo.current;
            const previous = source.pop();

            if (previous) {
              target.push(draft.current);
              write(previous);
            }

            return;
          }

          if (event.key === "Enter" && !modifier) {
            event.preventDefault();
            insertText("\n");

            return;
          }

          if (event.key !== "Escape" && !(event.key === "Enter" && modifier)) return;
          event.preventDefault();
          const surface = event.currentTarget.closest<HTMLElement>(".design-canvas");
          if (event.key === "Escape") {
            finished.current = true;
            onCancel?.(frame.id);
          } else commit();
          surface?.focus({ preventScroll: true });
        }}
        onKeyUp={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
      >
        {initialContent}
      </div>
      {position &&
        createPortal(
          <div
            ref={toolbar}
            className="canvas-text-format-toolbar"
            style={{ left: position.x, top: position.y }}
            role="toolbar"
            tabIndex={-1}
            aria-label="Text formatting"
            onPointerDown={(event) => {
              event.stopPropagation();
              if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
            }}
            onKeyDown={(event) => event.stopPropagation()}
            onBlur={(event) => {
              if (
                !event.currentTarget.contains(event.relatedTarget as Node | null) &&
                !input.current?.contains(event.relatedTarget as Node | null)
              )
                commit();
            }}
          >
            <button
              type="button"
              aria-label="Bold selection"
              disabled={!selected}
              onClick={() => toggle("fontWeight", 700)}
            >
              <strong>B</strong>
            </button>
            <button
              type="button"
              aria-label="Italic selection"
              disabled={!selected}
              onClick={() => toggle("fontStyle", "italic")}
            >
              <i>I</i>
            </button>
            <button
              type="button"
              aria-label="Underline selection"
              disabled={!selected}
              onClick={() => toggle("textDecoration", "underline")}
            >
              <u>U</u>
            </button>
            <input
              aria-label="Selection color"
              type="color"
              disabled={!selected}
              defaultValue={frame.color.slice(0, 7)}
              onChange={(event) => format({ color: event.currentTarget.value })}
            />
            <button
              type="button"
              disabled={!selected}
              onClick={() => {
                setLinkOpen(!linkOpen);
                setError("");
              }}
            >
              Link
            </button>
            <button
              type="button"
              disabled={!selected}
              onClick={() =>
                format({
                  color: null,
                  fontSize: null,
                  fontFamily: null,
                  fontWeight: null,
                  fontStyle: null,
                  textDecoration: null,
                  href: null,
                })
              }
            >
              Reset
            </button>
            {linkOpen && (
              <>
                <input
                  aria-label="Selection link"
                  type="url"
                  placeholder="https://…"
                  value={link}
                  onChange={(event) => setLink(event.currentTarget.value)}
                />
                <button
                  type="button"
                  onClick={() => {
                    if (link && !isCanvasTextLink(link)) {
                      setError("Use an https, http, or mailto link.");

                      return;
                    }

                    format({ href: link || null });
                    setLinkOpen(false);
                  }}
                >
                  Apply
                </button>
              </>
            )}
            {error && <span role="alert">{error}</span>}
          </div>,
          document.body,
        )}
    </>
  );
}
