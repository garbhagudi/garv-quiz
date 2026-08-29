import { Suspense } from "react";
import { getAdminSession, canWrite } from "@/lib/session";
import { OrganizationsClient } from "./OrganizationsClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Organizations" };

export default async function OrganizationsPage() {
  const session = await getAdminSession();
  return (
    <Suspense fallback={null}>
      <OrganizationsClient canWrite={canWrite(session)} />
    </Suspense>
  );
}
