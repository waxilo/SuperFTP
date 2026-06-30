import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { ConnectionProfile, Protocol } from "../types";

interface Props {
  initial: ConnectionProfile;
  title: string;
  onCancel: () => void;
  onSubmit: (profile: ConnectionProfile) => void;
}

/** Standard port for each protocol. Used to auto-flip the port field when
 *  the user toggles the protocol — but only if the current port is still
 *  the *other* protocol's default, so we don't clobber a custom value. */
const DEFAULT_PORTS: Record<Protocol, number> = {
  ftp: 21,
  sftp: 22,
};

export function ConnectionForm({ initial, title, onCancel, onSubmit }: Props) {
  const [profile, setProfile] = useState<ConnectionProfile>(initial);

  useEffect(() => {
    setProfile(initial);
  }, [initial]);

  function update<K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) {
    setProfile((prev) => ({ ...prev, [key]: value }));
  }

  function handleProtocolChange(next: Protocol) {
    setProfile((prev) => {
      const isAtOtherDefault = prev.port === DEFAULT_PORTS[prev.protocol];
      return {
        ...prev,
        protocol: next,
        port: isAtOtherDefault ? DEFAULT_PORTS[next] : prev.port,
      };
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!profile.name.trim() || !profile.host.trim()) return;
    onSubmit(profile);
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onCancel} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form className="form" onSubmit={handleSubmit}>
          <label>
            <span>Protocol</span>
            <div className="segmented">
              <button
                type="button"
                className={profile.protocol === "ftp" ? "active" : ""}
                onClick={() => handleProtocolChange("ftp")}
              >
                FTP
              </button>
              <button
                type="button"
                className={profile.protocol === "sftp" ? "active" : ""}
                onClick={() => handleProtocolChange("sftp")}
              >
                SFTP
              </button>
            </div>
          </label>

          <label>
            <span>Name</span>
            <input
              autoFocus
              value={profile.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="My Server"
              required
            />
          </label>

          <div className="form-row">
            <label className="grow">
              <span>Host</span>
              <input
                value={profile.host}
                onChange={(e) => update("host", e.target.value)}
                placeholder={profile.protocol === "sftp" ? "sftp.example.com" : "ftp.example.com"}
                required
              />
            </label>
            <label className="port">
              <span>Port</span>
              <input
                type="number"
                min={1}
                max={65535}
                value={profile.port}
                onChange={(e) =>
                  update("port", Number(e.target.value) || DEFAULT_PORTS[profile.protocol])
                }
              />
            </label>
          </div>

          <div className="form-row">
            <label className="grow">
              <span>Username</span>
              <input
                value={profile.username}
                onChange={(e) => update("username", e.target.value)}
                placeholder={profile.protocol === "sftp" ? "root" : "anonymous"}
              />
            </label>
            <label className="grow">
              <span>Password</span>
              <input
                type="password"
                value={profile.password}
                onChange={(e) => update("password", e.target.value)}
                placeholder=""
              />
            </label>
          </div>

          {profile.protocol === "ftp" && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={profile.passive}
                onChange={(e) => update("passive", e.target.checked)}
              />
              <span>Passive mode (recommended)</span>
            </label>
          )}

          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="btn primary">
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
