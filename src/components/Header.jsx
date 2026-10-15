import React from "react";
import { Settings, Moon } from "lucide-react";
import { useRomance } from "../context/RomanceContext";

export default function Header() {
  const { navigateTo, setIsSettingsOpen, settings, updateSetting } = useRomance();
  const toggleNightDim = () => updateSetting("dimPages", settings.dimPages > 0 ? 0 : 35);

  return (
    <header className="site-header">
      <div className="header-left">
        <div className="brand-logo" onClick={() => navigateTo("home")}>
          <span style={{ color: "#22d3ee", fontWeight: 800 }}>Blue Box</span>
          <span style={{ color: "#94a3b8", fontSize: "0.85rem", marginLeft: 8 }}>アオのハコ</span>
        </div>
      </div>
      <div style={{ flex: 1 }} />
      <div className="header-right">
        <button
          className="header-icon-btn"
          title={`Eye-Care Dimmer (${settings.dimPages > 0 ? "Active" : "Off"})`}
          onClick={toggleNightDim}
          style={settings.dimPages > 0 ? { color: "#22d3ee" } : {}}
        >
          <Moon size={19} />
        </button>
        <button className="header-icon-btn" title="Reader Settings" onClick={() => setIsSettingsOpen(true)}>
          <Settings size={19} />
        </button>
      </div>
    </header>
  );
}
