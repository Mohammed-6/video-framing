"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { SessionProvider } from "@/lib/session";

const NAV = [
  { href: "/discover", label: "Discover" },
  { href: "/library", label: "Library" },
  { href: "/review", label: "Review" },
  { href: "/publications", label: "Published" },
  { href: "/settings", label: "Settings" },
];

function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const [reviewCount, setReviewCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .review()
        .then((r) => alive && setReviewCount(r.items.length))
        .catch(() => undefined);
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pathname]);

  return (
    <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
        <Link href="/discover" className="flex items-center gap-2 font-semibold">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-brand-500 text-xs font-bold">CF</span>
          <span className="hidden sm:inline">ClipForge</span>
        </Link>
        <nav className="flex gap-1 overflow-x-auto">
          {NAV.map(({ href, label }) => {
            const active = pathname.startsWith(href) || (href === "/library" && pathname.startsWith("/videos"));
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${
                  active ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-white"
                }`}
              >
                {label}
                {href === "/review" && reviewCount ? (
                  <span className="rounded-full bg-brand-500 px-1.5 text-[11px] font-semibold text-white">{reviewCount}</span>
                ) : null}
              </Link>
            );
          })}
        </nav>
        <button
          className="btn-ghost ml-auto px-2 py-1 text-sm"
          onClick={async () => {
            await api.logout();
            router.replace("/login");
          }}
        >
          Sign out
        </button>
      </div>
    </header>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <Nav />
      <main className="mx-auto max-w-7xl px-4 py-8">{children}</main>
    </SessionProvider>
  );
}
