import {
  STARTER_THEME,
  type CanvasDocument,
  type ThemeToken,
  type ThemeTokenType,
} from "@flies/canvas";
import {
  ALargeSmallIcon,
  ChevronRightIcon,
  MonitorIcon,
  PlusIcon,
  SearchIcon,
  SquareIcon,
  TypeIcon,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { updateDocumentTheme } from "@/lib/canvas-theme-actions";

import "./canvas-theme-panel.css";

const TYPES: {
  value: ThemeTokenType;
  label: string;
  group: "shape" | "layout" | "type";
  initial: string | number;
}[] = [
  { value: "color", label: "Color", group: "shape", initial: "#6366f1" },
  { value: "radius", label: "Radius", group: "shape", initial: 8 },
  { value: "spacing", label: "Spacing", group: "layout", initial: 16 },
  { value: "container", label: "Container", group: "layout", initial: 768 },
  { value: "breakpoint", label: "Breakpoint", group: "layout", initial: 768 },
  { value: "fontFamily", label: "Font family", group: "type", initial: "Arial" },
  { value: "fontWeight", label: "Font weight", group: "type", initial: 400 },
  { value: "fontSize", label: "Font size", group: "type", initial: 16 },
  { value: "lineHeight", label: "Line height", group: "type", initial: 1.25 },
  { value: "letterSpacing", label: "Letter spacing", group: "type", initial: 0 },
];

function tokenPrefix(type: ThemeTokenType) {
  switch (type) {
    case "fontFamily":
      return "font";
    case "fontWeight":
      return "weight";
    case "fontSize":
      return "text";
    case "lineHeight":
      return "leading";
    case "letterSpacing":
      return "tracking";
    case "breakpoint":
      return "bp";
    default:
      return type;
  }
}

function formatValue(token: ThemeToken) {
  return token.type === "color" ? "" : String(token.value);
}

function tokenValueBounds(type: ThemeTokenType) {
  if (type === "fontSize") return { min: 1, max: 10000 };
  if (type === "fontWeight") return { min: 1, max: 1000 };
  if (type === "lineHeight") return { min: 0.5, max: 4 };
  if (type === "letterSpacing") return { min: -10, max: 100 };
  return { min: 0, max: 10000 };
}

function TypeGlyph({ type }: { type: ThemeTokenType }) {
  if (type === "color") return <SquareIcon size={14} strokeWidth={1.6} aria-hidden="true" />;
  if (type === "fontFamily") return <TypeIcon size={14} strokeWidth={1.6} aria-hidden="true" />;
  if (type === "fontSize")
    return <ALargeSmallIcon size={14} strokeWidth={1.6} aria-hidden="true" />;
  if (type === "breakpoint") return <MonitorIcon size={14} strokeWidth={1.6} aria-hidden="true" />;
  if (type === "radius") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <path
          d="M3 11V6a3 3 0 0 1 3-3h5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (type === "container") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <rect
          x="2.5"
          y="3.5"
          width="9"
          height="7"
          rx="1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        />
        <path d="M7 3.5v7" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    );
  }
  if (type === "fontWeight") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <path
          d="M4.5 11V4.2h2.1c1.55 0 2.5.85 2.5 2.1 0 .85-.5 1.5-1.25 1.8 1 .2 1.7.95 1.7 2 0 1.4-1.1 2.3-2.85 2.3z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (type === "lineHeight") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <path d="M2.5 3h9M2.5 11h9" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M4.8 10 7 4.2 9.2 10M5.4 8.4h3.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (type === "letterSpacing") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <path d="M3 3.5v7M11 3.5v7" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M5 10 7 4.4 9 10M5.5 8.4h3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M4 3.5 1.5 7 4 10.5M10 3.5 12.5 7 10 10.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CreateTokenMenu({
  disabled,
  onAdd,
  onClear,
  children,
  className,
  label,
  align = "end",
  side = "bottom",
}: {
  disabled: boolean;
  onAdd: (type: ThemeTokenType) => void;
  onClear?: () => void;
  children: ReactNode;
  className?: string;
  label: string;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={className} aria-label={label} disabled={disabled}>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        side={side}
        sideOffset={6}
        className="canvas-theme-create-menu z-[80] w-max min-w-44"
      >
        {TYPES.map((entry, index) => (
          <DropdownMenuGroup key={entry.value}>
            {index > 0 && entry.group !== TYPES[index - 1]?.group && <DropdownMenuSeparator />}
            <DropdownMenuItem onClick={() => onAdd(entry.value)}>
              <span className="canvas-theme-type-slot">
                <TypeGlyph type={entry.value} />
              </span>
              {entry.label}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        ))}
        {onClear && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onClear}>
              Clear theme
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TokenRow({
  token,
  selected,
  busy,
  onSelect,
  onEdit,
  onDelete,
}: {
  token: ThemeToken;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onEdit: (patch: Partial<ThemeToken>) => void;
  onDelete: () => void;
}) {
  const value = formatValue(token);
  return (
    <div
      className="canvas-theme-token"
      role="treeitem"
      aria-selected={selected}
      data-token-id={token.id}
      title={`CSS variable: --${token.id}`}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
        if (event.key === "Backspace" || event.key === "Delete") {
          event.preventDefault();
          onDelete();
        }
      }}
    >
      <span className="canvas-theme-type-slot">
        {token.type === "color" ? (
          <span className="canvas-theme-swatch" style={{ background: String(token.value) }} />
        ) : (
          <TypeGlyph type={token.type} />
        )}
      </span>
      {selected ? (
        <input
          className="canvas-theme-token-name"
          aria-label={`Token name ${token.id}`}
          defaultValue={token.name}
          disabled={busy}
          onClick={(event) => event.stopPropagation()}
          onBlur={(event) => {
            if (event.target.value !== token.name) onEdit({ name: event.target.value });
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      ) : (
        <span className="canvas-theme-token-name">{token.name}</span>
      )}
      {token.type === "color" && !selected ? null : selected ? (
        <input
          className="canvas-theme-token-value"
          aria-label={`Token value ${token.id}`}
          defaultValue={String(token.value)}
          disabled={busy}
          type={typeof token.value === "number" ? "number" : "text"}
          min={tokenValueBounds(token.type).min}
          max={tokenValueBounds(token.type).max}
          step="any"
          onClick={(event) => event.stopPropagation()}
          onBlur={(event) => {
            const next =
              typeof token.value === "number" ? Number(event.target.value) : event.target.value;
            if (next !== token.value) onEdit({ value: next });
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      ) : (
        <span
          className="canvas-theme-token-value"
          style={token.type === "fontFamily" ? { fontFamily: String(token.value) } : undefined}
        >
          {value}
        </span>
      )}
      <button
        type="button"
        className="canvas-theme-token-delete"
        disabled={busy}
        aria-label={`Delete token ${token.name}`}
        title="Delete token; linked layers keep their current values"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
      >
        ×
      </button>
    </div>
  );
}

export function CanvasThemePanel({ document }: { document: CanvasDocument }) {
  useSyncExternalStore(document.subscribe, document.getSnapshot, document.getSnapshot);
  const theme = document.getTheme();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<ThemeTokenType>>(() => new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);
  async function save(tokens: readonly ThemeToken[]) {
    setError("");
    setBusy(true);
    try {
      await updateDocumentTheme(document, { tokens });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  function add(type: ThemeTokenType) {
    const spec = TYPES.find((entry) => entry.value === type)!;
    const prefix = tokenPrefix(type);
    let index = 1;
    while (theme.tokens.some((token) => token.id === `${prefix}-${index}`)) index++;
    const id = `${prefix}-${index}`;
    setSelectedId(id);
    setCollapsed((current) => {
      if (!current.has(type)) return current;
      const next = new Set(current);
      next.delete(type);
      return next;
    });
    void save([...theme.tokens, { id, name: id, type, value: spec.initial }]);
  }
  function edit(token: ThemeToken, patch: Partial<ThemeToken>) {
    void save(
      theme.tokens.map((entry) => (entry.id === token.id ? { ...entry, ...patch } : entry)),
    );
  }
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? theme.tokens.filter((token) =>
        [token.id, token.name, String(token.value)].some((value) =>
          value.toLowerCase().includes(needle),
        ),
      )
    : theme.tokens;
  const groups = TYPES.flatMap((entry) => {
    const tokens = visible.filter((token) => token.type === entry.value);
    return tokens.length ? [{ type: entry.value, label: entry.label, tokens }] : [];
  });
  const empty = theme.tokens.length === 0;

  return (
    <div className="canvas-theme-panel" aria-label="Theme tokens" aria-busy={busy}>
      <div className="canvas-theme-toolbar">
        {searching ? (
          <input
            ref={searchRef}
            className="canvas-theme-search"
            aria-label="Search tokens"
            placeholder="Search tokens"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") {
                setQuery("");
                setSearching(false);
              }
            }}
          />
        ) : (
          <p className="canvas-theme-count">
            {empty
              ? "No tokens"
              : `${theme.tokens.length} token${theme.tokens.length === 1 ? "" : "s"}`}
          </p>
        )}
        <button
          type="button"
          className="canvas-theme-icon-button"
          aria-label={searching ? "Close search" : "Search tokens"}
          aria-pressed={searching}
          onClick={() => {
            setSearching((open) => !open);
            if (searching) setQuery("");
          }}
        >
          <SearchIcon size={14} strokeWidth={1.7} aria-hidden="true" />
        </button>
        <CreateTokenMenu
          disabled={busy}
          onAdd={add}
          onClear={empty ? undefined : () => void save([])}
          className="canvas-theme-icon-button"
          label="Add token"
          side="bottom"
          align="end"
        >
          <PlusIcon size={14} strokeWidth={1.7} aria-hidden="true" />
        </CreateTokenMenu>
      </div>
      {error && (
        <p role="alert" className="canvas-theme-error">
          {error}
        </p>
      )}
      {empty ? (
        <div className="canvas-theme-blank">
          <svg
            className="canvas-theme-blank-icon"
            width="40"
            height="40"
            viewBox="0 0 32 32"
            aria-hidden="true"
          >
            <rect
              x="4"
              y="4"
              width="10"
              height="10"
              rx="2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <path
              d="M21 5.5h6v6h-6zM19.5 21.5h5a2 2 0 0 1 2 2v5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <circle cx="9" cy="23" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M7.5 23h3M9 21.5v3"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          <h3>Theme tokens</h3>
          <p>
            Create tokens to get started,
            <br />
            or explore the starter theme.
          </p>
          <CreateTokenMenu
            disabled={busy}
            onAdd={add}
            className="canvas-theme-blank-primary"
            label="Create token"
            align="center"
            side="top"
          >
            Create token
          </CreateTokenMenu>
          <button
            type="button"
            className="canvas-theme-blank-secondary"
            disabled={busy}
            onClick={() => void save(STARTER_THEME.tokens)}
          >
            Use starter theme
          </button>
        </div>
      ) : (
        <div className="canvas-theme-list" role="tree" aria-label="Token list">
          {groups.length === 0 && <p className="canvas-theme-empty">No matching tokens</p>}
          {groups.map((group) => {
            const open = !collapsed.has(group.type) || Boolean(needle);
            return (
              <section key={group.type} className="canvas-theme-section" aria-label={group.label}>
                <button
                  type="button"
                  className="canvas-theme-section-header"
                  aria-expanded={open}
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(group.type)) next.delete(group.type);
                      else next.add(group.type);
                      return next;
                    })
                  }
                >
                  <ChevronRightIcon
                    className={open ? "is-expanded" : undefined}
                    size={12}
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                  {group.label}
                </button>
                {open &&
                  group.tokens.map((token) => (
                    <TokenRow
                      key={`${token.id}:${token.name}:${token.value}`}
                      token={token}
                      selected={selectedId === token.id}
                      busy={busy}
                      onSelect={() => setSelectedId(token.id)}
                      onEdit={(patch) => edit(token, patch)}
                      onDelete={() => {
                        if (selectedId === token.id) setSelectedId(null);
                        void save(theme.tokens.filter((entry) => entry.id !== token.id));
                      }}
                    />
                  ))}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
