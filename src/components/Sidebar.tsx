import { Server, Plus, Pencil, Trash2, Plug, PlugZap } from "lucide-react";
import type { ConnectionProfile } from "../types";

interface Props {
  profiles: ConnectionProfile[];
  activeProfileId: string | null;
  connecting: boolean;
  onAdd: () => void;
  onEdit: (profile: ConnectionProfile) => void;
  onDelete: (profile: ConnectionProfile) => void;
  onConnect: (profile: ConnectionProfile) => void;
  onDisconnect: () => void;
}

export function Sidebar({
  profiles,
  activeProfileId,
  connecting,
  onAdd,
  onEdit,
  onDelete,
  onConnect,
  onDisconnect,
}: Props) {
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

      <div className="sidebar-section-label">Connections</div>

      <ul className="connection-list">
        {profiles.length === 0 && (
          <li className="empty-hint">No saved connections. Click + to add one.</li>
        )}

        {profiles.map((profile) => {
          const active = profile.id === activeProfileId;
          return (
            <li key={profile.id} className={`connection-item ${active ? "active" : ""}`}>
              <button
                className="connection-main"
                onClick={() => (active ? onDisconnect() : onConnect(profile))}
                disabled={connecting && !active}
                title={active ? "Click to disconnect" : "Click to connect"}
              >
                {active ? <PlugZap size={16} /> : <Plug size={16} />}
                <div className="connection-text">
                  <div className="connection-name">{profile.name || profile.host}</div>
                  <div className="connection-sub">
                    {profile.protocol}://{profile.username}@{profile.host}:{profile.port}
                  </div>
                </div>
              </button>

              <div className="connection-actions">
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
