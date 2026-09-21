import { ChevronDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

export function IconButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="canvas-property-icon-button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(true);

  return (
    <section className="canvas-properties-section" aria-label={title}>
      <div className="canvas-properties-section-heading">
        <h3>
          <button
            type="button"
            className="canvas-section-toggle"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {title}
            <ChevronDownIcon size={12} />
          </button>
        </h3>
        {actions && <div className="canvas-properties-actions">{actions}</div>}
      </div>
      {open && children}
    </section>
  );
}
