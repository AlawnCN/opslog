import { useEffect, useState } from "react";

interface NumericInputProps {
  value: number;
  onChange: (value: number) => void;
  integer?: boolean;
  minimum?: number;
  maximum?: number;
  ariaLabel?: string;
}

export const NumericInput = ({ value, onChange, integer = true, minimum = 0, maximum = Number.MAX_SAFE_INTEGER, ariaLabel }: NumericInputProps) => {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setText(String(value));
  }, [editing, value]);

  const commit = () => {
    setEditing(false);
    const parsed = Number(text);
    const next = Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, integer ? Math.round(parsed) : parsed)) : value;
    setText(String(next));
    if (next !== value) onChange(next);
  };

  return <input
    type="text"
    inputMode={integer ? "numeric" : "decimal"}
    aria-label={ariaLabel}
    value={text}
    onFocus={(event) => { setEditing(true); event.currentTarget.select(); }}
    onChange={(event) => {
      const cleaned = event.currentTarget.value.replace(integer ? /[^0-9]/g : /[^0-9.]/g, "");
      const next = integer ? cleaned : cleaned.replace(/(\..*)\./g, "$1");
      setText(next);
      const parsed = Number(next);
      if (next && Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum) onChange(integer ? Math.round(parsed) : parsed);
    }}
    onBlur={commit}
    onKeyDown={(event) => {
      if (event.key === "Enter") event.currentTarget.blur();
      if (event.key === "Escape") { setText(String(value)); event.currentTarget.blur(); }
    }}
  />;
};
