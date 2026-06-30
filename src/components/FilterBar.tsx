import { useEffect, useRef } from "react";
import { Search, X } from "lucide-react";

interface Props {
  value: string;
  matched: number;
  total: number;
  onChange: (value: string) => void;
  onClose: () => void;
}

export function FilterBar({ value, matched, total, onChange, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="filter-bar" role="search">
      <Search size={14} className="filter-icon" />
      <input
        ref={inputRef}
        className="filter-input"
        placeholder="Filter files — supports * and ? (Esc to close)"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="filter-count">
        {value ? `${matched}/${total}` : total}
      </span>
      <button className="icon-btn small" onClick={onClose} title="Close filter">
        <X size={14} />
      </button>
    </div>
  );
}
