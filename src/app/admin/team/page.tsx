import { getAdminSession } from "@/lib/session";
import { TeamClient } from "./TeamClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Team" };

export default async function TeamPage() {
  const session = await getAdminSession();
  return <TeamClient meId={session?.aid ?? 0} isOwner={session?.role === "owner"} />;
}
