import type { Metadata } from "next";
import { getAdminSession } from "@/lib/session";
import { AdminNav } from "./AdminNav";

export const metadata: Metadata = { title: { default: "Admin", template: "%s - Quiz Admin" } };

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();

  // The sign-in page shares this route segment but wants no chrome around it.
  if (!session) return <div className="surface-desk">{children}</div>;

  return (
    <div className="surface-desk">
      <AdminNav
        name={session.name}
        email={session.email}
        role={session.role}
      />
      <main className="mx-auto w-full max-w-[1180px] px-4 pb-16 pt-5 sm:px-6">{children}</main>
    </div>
  );
}
