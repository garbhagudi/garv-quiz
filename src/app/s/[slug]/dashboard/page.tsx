import { notFound } from "next/navigation";
import { getOrganizationBySlug } from "@/lib/queries";
import { Stage } from "@/components/Stage";
import { StudentDashboard } from "./StudentDashboard";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export default async function DashboardPage({ params }: Props) {
  const { slug } = await params;
  const organization = await getOrganizationBySlug(slug);
  if (!organization) notFound();

  return (
    <Stage eyebrow={[organization.name, organization.city].filter(Boolean).join(" · ")}>
      <StudentDashboard slug={organization.slug} />
    </Stage>
  );
}
