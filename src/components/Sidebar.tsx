import {
  HardDrive,
  Pencil,
  Plug,
  PlugZap,
  Plus,
  Server,
  Trash2,
  Unplug,
} from "lucide-react";
import type { ConnectionProfile } from "../types";

interface Props {
  profiles: ConnectionProfile[];
  /** Profile shown in the main pane, or `null` when the pinned local card is
   *  the one on screen. The local card is the default selection on startup. */
  selectedProfileId: string | null;
  /** Profile with a live session. Not necessarily the selected one: switching
   *  to local browsing keeps the remote session open so files can still be
   *  sent to it. */
  connectedProfileId: string | null;
  connecting: boolean;
  /** Directory the local browser is currently showing, used as the card's
   *  subtitle so the location stays visible even while a remote is selected. */
  localPath: string;
  onSelectLocal: () => void;
  onAdd: () => void;
  onEdit: (profile: ConnectionProfile) => void;
  onDelete: (profile: ConnectionProfile) => void;
  onSelectProfile: (profile: ConnectionProfile) => void;
  onDisconnect: () => void;
}

export function Sidebar({
  profiles,
  selectedProfileId,
  connectedProfileId,
  connecting,
  localPath,
  onSelectLocal,
  onAdd,
  onEdit,
  onDelete,
  onSelectProfile,
  onDisconnect,
}: Props) {
  const localSelected = selectedProfileId === null;

  return (
    <section className="connections-panel">
      <div className="sidebar-header">
        <div className="brand">
          <Server size={18} />
          <span>SuperFTP</span>
        </div>
        <button className="icon-btn" onClick={onAdd} title="Add connection">
          <Plus size={16} />
        </button>
      </div>

      {/* The local filesystem is modelled as a connection that's always
          available, pinned above the saved ones and selected by default. It
          lives outside the scrolling list so it can never be scrolled away. */}
      <div className="sidebar-section-label">This computer</div>
      <ul className="connection-list pinned">
        <li className={`connection-item ${localSelected ? "active" : ""}`}>
          <button
            className="connection-main"
            onClick={onSelectLocal}
            title="Browse local files"
          >
            <HardDrive size={16} />
            <div className="connection-text">
              <div className="connection-name">Local Files</div>
              <div className="connection-sub path" title={localPath}>
                {localPath || "—"}
              </div>
            </div>
          </button>
        </li>
      </ul>

      <div className="sidebar-section-label">Connections</div>

      <ul className="connection-list">
        {profiles.length === 0 && (
          <li className="empty-hint">No saved connections. Click + to add one.</li>
        )}

        {profiles.map((profile) => {
          const selected = profile.id === selectedProfileId;
          const connected = profile.id === connectedProfileId;
          return (
            <li
              key={profile.id}
              className={[
                "connection-item",
                selected ? "active" : "",
                connected ? "connected" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <button
                className="connection-main"
                onClick={() => onSelectProfile(profile)}
                disabled={connecting && !selected}
                title={
                  connected
                    ? selected
                      ? "Connected"
                      : "Connected — click to show"
                    : "Click to connect"
                }
              >
                {connected ? <PlugZap size={16} /> : <Plug size={16} />}
                <div className="connection-text">
                  <div className="connection-name">{profile.name || profile.host}</div>
                  <div className="connection-sub">
                    {profile.protocol}://{profile.username}@{profile.host}:{profile.port}
                  </div>
                </div>
              </button>

              <div className="connection-actions">
                {connected && (
                  <button
                    className="icon-btn small danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDisconnect();
                    }}
                    title="Disconnect"
                  >
                    <Unplug size={14} />
                  </button>
                )}
                <button
                  className="icon-btn small"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(profile);
                  }}
                  title="Edit"
                >
                  <Pencil size={14} />
                </button>
                <button
                  className="icon-btn small danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(profile);
                  }}
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
