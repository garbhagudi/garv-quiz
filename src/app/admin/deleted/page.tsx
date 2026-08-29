import { getAdminSession, canWrite } from "@/lib/session";
import { DeletedClient } from "./DeletedClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Deleted" };

export default async function DeletedPage() {
  const session = await getAdminSession();
  return <DeletedClient canWrite={canWrite(session)} />;
}
