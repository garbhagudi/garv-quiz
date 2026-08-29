import { getAdminSession, canWrite } from "@/lib/session";
import { QuestionsClient } from "./QuestionsClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Questions" };

export default async function QuestionsPage() {
  const session = await getAdminSession();
  return <QuestionsClient canWrite={canWrite(session)} />;
}
