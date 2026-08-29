import Link from "next/link";
import { BrandBar } from "@/components/Stage";
import { CodeEntry } from "./CodeEntry";

/**
 * The one link that gets shared at every talk. Students type the event code
 * their host gives them; staff slip through to the admin panel from the footer.
 */
export default function Home() {
  return (
    <div className="surface-stage flex justify-center px-3.5 pb-9 pt-4.5">
      <div className="w-full max-w-[560px]">
        <p className="eyebrow mb-2.5 mt-0.5 text-center text-brand-deep">
          GARV 2026
        </p>
        <BrandBar />

        <main className="card animate-rise">
          <h1 className="mb-3 font-display text-[30px] font-bold leading-[1.1] tracking-[-0.02em] text-plum">
            Quiz Challenge
          </h1>
          <p className="mb-5.5 font-display text-[19px] font-light leading-snug text-plum-soft">
            Every one of us began as a single cell. How much do you know about
            what happens next?
          </p>

          <CodeEntry />
        </main>

        <p className="mt-5 text-center text-[12px] leading-relaxed text-muted">
          GarbhaGudi IVF Centre ·{" "}
          <Link href="/admin/login" className="underline underline-offset-2 hover:text-brand-deep">
            Team sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
