import { notFound } from "next/navigation";
import { getAdminSession, canWrite } from "@/lib/session";
import { getOrganizationByIdOrSlug } from "@/lib/queries";
import { OrganizationResults } from "@/components/admin/OrganizationResults";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props) {
  const organization = await getOrganizationByIdOrSlug((await params).id);
  return { title: organization?.name ?? "Organization" };
}

/**
 * Reached by id from the list, and by code from anywhere else — so
 * /admin/organizations/garv opens the same page as /admin/organizations/5.
 */
export default async function OrganizationDetailPage({ params }: Props) {
  const organization = await getOrganizationByIdOrSlug((await params).id);
  if (!organization) notFound();

  const session = await getAdminSession();
  return (
    <OrganizationResults organizationId={Number(organization.id)} canWrite={canWrite(session)} />
  );
}
