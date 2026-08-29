import { getAdminSession, canWrite } from "@/lib/session";
import { PeopleClient } from "./PeopleClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "People" };

export default async function PeoplePage() {
  const session = await getAdminSession();
  return <PeopleClient canWrite={canWrite(session)} />;
}
