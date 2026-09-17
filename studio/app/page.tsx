"use client";

import { useState } from "react";

export default function Home() {
  const [status, setStatus] = useState("OFFLINE");

  return (
    <div>
      <h1>MIRAGE Studio</h1>
      <p className="bg-black text-white">
        Mirage #001 — <button type="button" onClick={() => setStatus((current) => current === "OFFLINE" ? "ONLINE" : "OFFLINE")}>{status}</button>
      </p>
    </div>
  );
}
