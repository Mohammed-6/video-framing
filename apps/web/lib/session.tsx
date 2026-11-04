"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { ApiError, api } from "./api";

type Session = { youtubeSearchEnabled: boolean };
const SessionContext = createContext<Session>({ youtubeSearchEnabled: false });

/** Single-owner app: just confirm the session cookie is valid, else go to /login. */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const router = useRouter();

  useEffect(() => {
    api
      .me()
      .then((m) => setSession({ youtubeSearchEnabled: m.youtubeSearchEnabled }))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) router.replace("/login");
      });
  }, [router]);

  if (!session) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-zinc-500">Loading…</div>;
  }
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
