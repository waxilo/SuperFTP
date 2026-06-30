import { ChevronRight, Home } from "lucide-react";

interface Props {
  path: string;
  onNavigate: (path: string) => void;
}

export function Breadcrumb({ path, onNavigate }: Props) {
  const segments = path.split("/").filter(Boolean);
  // Build cumulative paths for each segment, e.g. /a, /a/b, /a/b/c
  const crumbs = segments.map((segment, i) => ({
    name: segment,
    path: "/" + segments.slice(0, i + 1).join("/"),
  }));

  return (
    <nav className="breadcrumb" aria-label="Path">
      <button className="crumb root" onClick={() => onNavigate("/")} title="Root">
        <Home size={14} />
      </button>
      {crumbs.map((crumb, idx) => (
        <span key={crumb.path} className="crumb-wrap">
          <ChevronRight size={14} className="crumb-sep" />
          <button
            className={`crumb ${idx === crumbs.length - 1 ? "current" : ""}`}
            onClick={() => onNavigate(crumb.path)}
          >
            {crumb.name}
          </button>
        </span>
      ))}
    </nav>
  );
}
