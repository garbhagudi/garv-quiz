import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getAdminSession } from "@/lib/session";
import { BrandBar } from "@/components/Stage";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Team sign in" };

export default async function AdminLoginPage() {
  // Already signed in? Skip the form.
  if (await getAdminSession()) redirect("/admin");

  return (
    <div className="surface-stage flex justify-center px-3.5 pb-9 pt-4.5">
      <div className="w-full max-w-[440px]">
        <p className="eyebrow mb-2.5 mt-0.5 text-center text-brand-deep">GarbhaGudi · Staff</p>
        <BrandBar />
        <main className="card animate-rise">
          <h1 className="mb-2 font-display text-[26px] font-bold leading-tight text-plum">
            Team sign in
          </h1>
          <Suspense fallback={null}>
            <LoginForm />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
