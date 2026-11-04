"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      router.replace("/discover");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5">
        <div className="text-center">
          <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-xl bg-brand-500 font-bold">CF</div>
          <h1 className="text-2xl font-semibold">ClipForge</h1>
          <p className="mt-1 text-sm text-zinc-400">Long videos in, shorts out.</p>
        </div>
        <div className="card space-y-4 p-6">
          <label className="block">
            <span className="label">Password</span>
            <input
              className="input"
              type="password"
              autoFocus
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>
    </div>
  );
}
