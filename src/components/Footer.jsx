import React from "react";

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-bottom" style={{ flexDirection: "column", gap: "0.4rem", textAlign: "center" }}>
        <div>A Blue Box (Ao no Hako) fan reader. Blue Box is by Kouji Miura, published by Shueisha.</div>
        <div style={{ color: "#64748b", fontSize: "0.8rem" }}>
          Officially licensed chapters are linked to the publisher's site and are not hosted here.
        </div>
      </div>
    </footer>
  );
}
