import { ChevronRight, HardDrive, Home } from "lucide-react";

interface Props {
  path: string;
  onNavigate: (path: string) => void;
}

export function Breadcrumb({ path, onNavigate }: Props) {
  // Remote paths are POSIX ("/a/b"), local ones may be Windows drives
  // ("C:/Users/me") — both arrive with forward slashes, so the only thing
  // that differs is the root. Splitting a drive path against "/" would build
  // crumbs like "/C:" and navigate nowhere, hence the explicit root.
  const drive = /^([A-Za-z]:)\//.exec(path);
  const root = drive ? `${drive[1]}/` : "/";
  const rest = drive ? path.slice(root.length) : path;

  const segments = rest.split("/").filter(Boolean);
  // Cumulative paths for each segment, e.g. /a, /a/b, /a/b/c
  const crumbs = segments.map((segment, i) => ({
    name: segment,
    path: root + segments.slice(0, i + 1).join("/"),
  }));

  return (
    <nav className="breadcrumb" aria-label="Path">
      <button
        className="crumb root"
        onClick={() => onNavigate(root)}
        title={drive ? root : "Root"}
      >
        {drive ? (
          <>
            <HardDrive size={14} />
            <span>{drive[1]}</span>
          </>
        ) : (
          <Home size={14} />
        )}
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
