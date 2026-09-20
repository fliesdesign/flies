import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  APPEARANCE_RANGE,
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  DEFAULT_UI_COLORS,
  UI_COLOR_TOKENS,
  loadAppearance,
  parseUiHex,
  saveAppearance,
  isDefaultAppearance,
  type Appearance,
  type UiColorId,
} from "@/lib/appearance";

import "./appearance-settings.css";

const GROUPS = [...new Set(UI_COLOR_TOKENS.map((token) => token.group))];

function SliderRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="appearance-slider">
      <span>{label}</span>
      <input
        type="range"
        min={APPEARANCE_RANGE.min}
        max={APPEARANCE_RANGE.max}
        value={value}
        aria-valuetext={`${value}`}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="appearance-slider-value">{value}</span>
    </label>
  );
}

function ColorRow({
  id,
  label,
  value,
  customized,
  onChange,
  onReset,
}: {
  id: UiColorId;
  label: string;
  value: string;
  customized: boolean;
  onChange: (id: UiColorId, value: string) => void;
  onReset: (id: UiColorId) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [previous, setPrevious] = useState(value);

  if (previous !== value) {
    setPrevious(value);
    setDraft(value);
  }

  return (
    <div className="appearance-color">
      <label className="appearance-swatch" title={label}>
        <span style={{ background: value }} />
        <input
          type="color"
          aria-label={label}
          value={value}
          onChange={(event) => onChange(id, event.target.value)}
        />
      </label>
      <span className="appearance-color-name">{label}</span>
      <input
        className="appearance-color-hex"
        aria-label={`${label} hex`}
        value={draft}
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const parsed = parseUiHex(next);
          if (parsed) onChange(id, parsed);
        }}
        onBlur={() => setDraft(value)}
      />
      <button
        type="button"
        className="appearance-color-reset"
        aria-label={`Reset ${label}`}
        disabled={!customized}
        onClick={() => onReset(id)}
      >
        ×
      </button>
    </div>
  );
}

export function AppearanceSettings() {
  const [appearance, setAppearance] = useState(loadAppearance);
  useEffect(() => {
    function sync(event: StorageEvent) {
      if (event.key === APPEARANCE_STORAGE_KEY) setAppearance(loadAppearance());
    }

    window.addEventListener("storage", sync);

    return () => window.removeEventListener("storage", sync);
  }, []);

  function commit(next: Appearance) {
    setAppearance(saveAppearance(next));
  }

  function setColor(id: UiColorId, hex: string) {
    const colors = { ...appearance.colors };
    const parsed = parseUiHex(hex) ?? DEFAULT_UI_COLORS[id];
    if (parsed === DEFAULT_UI_COLORS[id]) delete colors[id];
    else colors[id] = parsed;
    commit({ ...appearance, colors });
  }

  return (
    <div className="appearance-settings">
      <section className="appearance-section" aria-labelledby="appearance-grade">
        <div className="appearance-section-head">
          <h2 id="appearance-grade">Look</h2>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={isDefaultAppearance(appearance)}
            onClick={() => commit(DEFAULT_APPEARANCE)}
          >
            Reset appearance
          </Button>
        </div>
        <SliderRow
          label="Brightness"
          value={appearance.brightness}
          onChange={(brightness) => commit({ ...appearance, brightness })}
        />
        <SliderRow
          label="Contrast"
          value={appearance.contrast}
          onChange={(contrast) => commit({ ...appearance, contrast })}
        />
        <p className="appearance-hint">Applied on top of the colors below.</p>
      </section>
      {GROUPS.map((group) => (
        <section key={group} className="appearance-section" aria-label={group}>
          <h2>{group}</h2>
          <div className="appearance-colors">
            {UI_COLOR_TOKENS.filter((token) => token.group === group).map((token) => (
              <ColorRow
                key={token.id}
                id={token.id}
                label={token.label}
                value={appearance.colors[token.id] ?? DEFAULT_UI_COLORS[token.id]}
                customized={Boolean(appearance.colors[token.id])}
                onChange={setColor}
                onReset={(id) => setColor(id, DEFAULT_UI_COLORS[id])}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
