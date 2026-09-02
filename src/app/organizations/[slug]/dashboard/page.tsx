import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

/**
 * /organizations/<code>/dashboard - the short URL, for typing from memory.
 *
 * A redirect rather than a second copy of the screen: the dashboard lives under
 * /admin, where the middleware bounces anonymous visitors to sign-in before any
 * page code runs. Serving it from here as well would mean two routes to keep in
 * step and one of them outside that guard.
 *
 * `organizations` is a reserved code, so this can never shadow a real event.
 */
export default async function ShortDashboardRedirect({ params }: Props) {
  const { slug } = await params;
  redirect(`/admin/organizations/${encodeURIComponent(slug)}/dashboard`);
}
