import { notFound } from "next/navigation";
import { getAdminSession, canWrite } from "@/lib/session";
import { getOrganizationByIdOrSlug } from "@/lib/queries";
import { RunDashboard } from "./RunDashboard";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props) {
  const organization = await getOrganizationByIdOrSlug((await params).id);
  return { title: organization ? `${organization.name} — live` : "Live dashboard" };
}

/**
 * /admin/organizations/<id or code>/dashboard
 *
 * The run screen on its own, so it can be opened on a second screen and left
 * there. Addressed by the event's code as readily as by its id — a host can
 * type /admin/organizations/garv/dashboard from memory, which is the point of
 * it having a URL at all.
 */
export default async function OrganizationDashboardPage({ params }: Props) {
  const organization = await getOrganizationByIdOrSlug((await params).id);
  if (!organization) notFound();

  const session = await getAdminSession();
  return (
    <RunDashboard organizationId={Number(organization.id)} canWrite={canWrite(session)} />
  );
}
