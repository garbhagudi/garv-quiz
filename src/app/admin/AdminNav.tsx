"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import type { Role } from "@/lib/types";

const LINKS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/organizations", label: "Organizations" },
  { href: "/admin/questions", label: "Questions" },
  { href: "/admin/people", label: "People" },
  { href: "/admin/team", label: "Team" },
  { href: "/admin/deleted", label: "Deleted" },
  { href: "/admin/activity", label: "Activity" },
];

const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  viewer: "View only",
};

export function AdminNav({ name, email, role }: { name: string; email: string; role: Role }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const active = (href: string) =>
    href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);

  async function signOut() {
    await api("/api/admin/session", { method: "DELETE" }).catch(() => {});
    router.push("/admin/login");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-brand-dark">
      <div className="mx-auto flex w-full max-w-[1180px] items-center gap-3 px-4 py-2.5 sm:px-6">
        <Link href="/admin" className="flex shrink-0 items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-apricot font-display text-[15px] font-bold text-brand-dark">
            G
          </span>
          <span className="hidden font-display text-[14px] font-medium tracking-wide text-white sm:block">
            Quiz Admin
          </span>
        </Link>

        <nav className="ml-2 hidden flex-1 items-center gap-0.5 md:flex">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={[
                "rounded-[10px] px-3 py-2 font-display text-[13.5px] font-medium transition",
                active(l.href)
                  ? "bg-white/[0.14] text-white"
                  : "text-brand-tint hover:bg-white/[0.07] hover:text-white",
              ].join(" ")}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2.5">
          <div className="hidden text-right leading-tight sm:block">
            <div className="font-display text-[13px] font-medium text-white">{name}</div>
            <div className="text-[11px] text-brand-tint/70">
              {ROLE_LABEL[role]} · {email}
            </div>
          </div>
          <button
            onClick={() => void signOut()}
            className="rounded-[10px] border border-white/20 px-3 py-1.5 font-display text-[12.5px] font-medium text-brand-tint transition hover:bg-white/10 hover:text-white"
          >
            Sign out
          </button>
          <button
            onClick={() => setOpen(!open)}
            className="grid h-9 w-9 place-items-center rounded-[10px] border border-white/20 text-white md:hidden"
            aria-label="Menu"
            aria-expanded={open}
          >
            <span className="text-[17px] leading-none">{open ? "✕" : "☰"}</span>
          </button>
        </div>
      </div>

      {open ? (
        <nav className="grid gap-1 border-t border-white/10 px-4 py-2.5 md:hidden">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className={[
                "rounded-[10px] px-3 py-2.5 font-display text-[14px] font-medium",
                active(l.href) ? "bg-white/[0.14] text-white" : "text-brand-tint",
              ].join(" ")}
            >
              {l.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </header>
  );
}
