import { notFound } from "next/navigation";
import { getAdminSession, canWrite } from "@/lib/session";
import { getOrganizationById } from "@/lib/queries";
import { OrganizationResults } from "@/components/admin/OrganizationResults";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props) {
  const organization = await getOrganizationById(Number((await params).id));
  return { title: organization?.name ?? "Organization" };
}

export default async function OrganizationDetailPage({ params }: Props) {
  const id = Number((await params).id);
  if (!Number.isFinite(id) || id <= 0) notFound();
  if (!(await getOrganizationById(id))) notFound();

  const session = await getAdminSession();
  return <OrganizationResults organizationId={id} canWrite={canWrite(session)} />;
}
