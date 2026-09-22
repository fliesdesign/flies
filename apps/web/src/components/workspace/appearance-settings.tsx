import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  APPEARANCE_RANGE,
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  loadAppearance,
  saveAppearance,
  isDefaultAppearance,
  type Appearance,
} from "@/lib/appearance";

import "./appearance-settings.css";

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
        <p className="appearance-hint">
          Adjust the interface on this device. Your designs keep their original colors.
        </p>
      </section>
    </div>
  );
}
