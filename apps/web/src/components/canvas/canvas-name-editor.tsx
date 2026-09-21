import { useEffect, useRef, useState } from "react";

/** Shared inline rename field for layer rows and page rows. */
export function CanvasNameEditor({
  name,
  label,
  onSave,
  onCancel,
}: {
  name: string;
  label: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const [value, setValue] = useState(name);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (cancel: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (cancel || !value.trim()) onCancel();
    else onSave(value.trim());
  };

  return (
    <input
      ref={inputRef}
      className="canvas-layer-name-input"
      aria-label={label}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onBlur={() => finish(false)}
      onKeyDown={(event) => {
        event.stopPropagation();

        if (event.key === "Enter" || event.key === "Escape") {
          event.preventDefault();
          finish(event.key === "Escape");
        }
      }}
    />
  );
}
