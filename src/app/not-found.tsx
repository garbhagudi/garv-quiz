import Link from "next/link";
import { BrandBar } from "@/components/Stage";

export const metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <div className="surface-stage flex justify-center px-3.5 pb-9 pt-4.5">
      <div className="w-full max-w-[440px]">
        <BrandBar />
        <main className="card animate-rise">
          <h1 className="mb-3 font-display text-[26px] font-bold leading-tight text-plum">
            Nothing here
          </h1>
          <p className="mb-5 text-[15.5px] leading-relaxed text-body">
            That link does not match an event. Codes are short and easy to mistype - worth checking
            the spelling.
          </p>
          <Link href="/" className="btn-primary">
            Enter an event code
          </Link>
        </main>
      </div>
    </div>
  );
}
