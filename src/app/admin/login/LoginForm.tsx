"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api, errText } from "@/lib/client";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/admin";

  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api("/api/admin/session", { body: form });
      // Only follow in-app paths, so `?next=` can never bounce to another site.
      router.push(next.startsWith("/") && !next.startsWith("//") ? next : "/admin");
      router.refresh();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <label className="field" htmlFor="email">
        Email
      </label>
      <input
        id="email"
        className="input"
        type="email"
        inputMode="email"
        autoComplete="username"
        value={form.email}
        onChange={(e) => setForm({ ...form, email: e.target.value })}
        disabled={busy}
      />

      <label className="field" htmlFor="password">
        Password
      </label>
      <input
        id="password"
        className="input"
        type="password"
        autoComplete="current-password"
        value={form.password}
        onChange={(e) => setForm({ ...form, password: e.target.value })}
        disabled={busy}
      />

      <p className="err mt-2.5" role="alert">
        {error}
      </p>

      <button type="submit" className="btn-primary mt-4" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>

      <p className="mt-4 text-center">
        <Link href="/" className="linkish">
          Back to the quiz
        </Link>
      </p>
    </form>
  );
}
