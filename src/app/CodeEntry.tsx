"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errText } from "@/lib/client";

/**
 * Checks the code before navigating, so a typo produces a clear message here
 * rather than a 404 page after a route change.
 */
export function CodeEntry() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    const clean = code.trim().toLowerCase().replace(/\s+/g, "-");
    if (!clean) return setError("Enter an event code.");

    setBusy(true);
    setError("");
    try {
      await api(`/api/public/organization?code=${encodeURIComponent(clean)}`);
      router.push(`/s/${clean}`);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={go} noValidate>
      <label className="field" htmlFor="code">
        Event code
      </label>
      <input
        id="code"
        className="input font-mono tracking-wide"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="e.g. demo"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        autoComplete="off"
        enterKeyHint="go"
        disabled={busy}
      />
      <p className="err mt-2.5" role="alert">
        {error}
      </p>

      <button type="submit" className="btn-primary mt-4" disabled={busy}>
        {busy ? "Checking…" : "Continue"}
      </button>
    </form>
  );
}
