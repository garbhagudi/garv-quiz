import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getOrganizationBySlug } from "@/lib/queries";
import { getAdminSession, canWrite } from "@/lib/session";
import { BrandBar } from "@/components/Stage";
import { OrganizationResults } from "@/components/admin/OrganizationResults";
import { LoginForm } from "@/app/admin/login/LoginForm";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props) {
  const organization = await getOrganizationBySlug((await params).slug);
  return { title: organization ? `${organization.name} — staff` : "Staff" };
}

/**
 * The staff door on an organization's own URL: /s/<code>/admin
 *
 * This is the flow used at an event — the host is already on the organization link, so
 * signing in here shows that organization's winners and full details without having to
 * navigate the whole admin panel. Same credentials as /admin/login.
 */
export default async function OrganizationAdminPage({ params }: Props) {
  const { slug } = await params;
  const organization = await getOrganizationBySlug(slug);
  if (!organization) notFound();

  const session = await getAdminSession();

  if (!session)
    return (
      <div className="surface-stage flex justify-center px-3.5 pb-9 pt-4.5">
        <div className="w-full max-w-[440px]">
          <p className="eyebrow mb-2.5 mt-0.5 text-center text-brand-deep">
            {organization.name} · Staff
          </p>
          <BrandBar />
          <main className="card animate-rise">
            <h1 className="mb-1 font-display text-[26px] font-bold leading-tight text-plum">
              Staff sign in
            </h1>
            <p className="mb-2 text-[15px] leading-relaxed text-[#463359]">
              Results for <b>{organization.name}</b>.
            </p>
            <Suspense fallback={null}>
              <LoginForm />
            </Suspense>
            <p className="mt-4 text-center">
              <Link href={`/s/${organization.slug}/dashboard`} className="linkish">
                Student? Open your own dashboard
              </Link>
            </p>
          </main>
        </div>
      </div>
    );

  return (
    <div className="surface-desk">
      <div className="border-b border-white/10 bg-brand-dark">
        <div className="mx-auto flex w-full max-w-[1180px] flex-wrap items-center gap-3 px-4 py-2.5 sm:px-6">
          <span className="font-display text-[13.5px] font-medium text-white">
            {session.name}
          </span>
          <span className="text-[12px] text-brand-tint">{session.email}</span>
          <div className="ml-auto flex gap-3">
            <Link
              href="/admin"
              className="font-display text-[13px] text-brand-tint hover:text-white"
            >
              Full admin panel →
            </Link>
          </div>
        </div>
      </div>
      <main className="mx-auto w-full max-w-[1180px] px-4 pb-16 pt-5 sm:px-6">
        <OrganizationResults organizationId={organization.id} canWrite={canWrite(session)} compact />
      </main>
    </div>
  );
}
