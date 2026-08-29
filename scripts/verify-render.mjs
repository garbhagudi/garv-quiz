/**
 * Renders the components that draw question wording and checks the markup they
 * produce.
 *
 *   node scripts/verify-render.mjs
 *
 * Everything else in `npm run verify` tests strings and SQL; this is the only
 * check on what a browser is actually handed. It matters most for escaping: a
 * question is written by staff and shown to every student, so if `<script>` in
 * the wording could ever reach the page as markup rather than as text, it would
 * be an injection into a room full of phones. React escapes it — this proves it
 * stays that way.
 *
 * `QuestionText` is pure JSX with no hooks, so server rendering exercises
 * exactly what a browser builds. TypeScript compiles it to a scratch directory
 * inside the project first (Node cannot strip JSX on its own), which is removed
 * afterwards. Needs no network and no database.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Inside the project, so the compiled output can still resolve `react`.
const out = join(root, ".next-render");

let failures = 0;
const check = (label, cond, note = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${note ? ` — ${note}` : ""}`);
  if (!cond) failures++;
};

console.log("\nRendering question wording\n");

rmSync(out, { recursive: true, force: true });

const tsc = spawnSync(
  process.execPath,
  [
    join(root, "node_modules", "typescript", "bin", "tsc"),
    join(root, "src", "components", "QuestionText.tsx"),
    join(root, "src", "lib", "questionText.ts"),
    "--outDir", out,
    "--rootDir", join(root, "src"),
    "--jsx", "react-jsx",
    "--module", "esnext",
    "--target", "es2022",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
  ],
  { cwd: root, encoding: "utf8" },
);

// tsc reports the unresolved "@/lib/questionText" alias — it has no tsconfig
// here — but still emits both files, which is all this needs. Anything else is
// a real compile error worth stopping for.
const noise = /Cannot find module '@\/lib\/questionText'/;
const realErrors = (tsc.stdout ?? "")
  .split("\n")
  .filter((l) => l.includes("error TS") && !noise.test(l));
if (realErrors.length) {
  console.error(`  FAIL  QuestionText.tsx does not compile\n        ${realErrors.join("\n        ")}\n`);
  process.exit(1);
}

// The compiled component still imports "@/lib/questionText"; point that at its
// compiled sibling, the same trick scripts/ts-resolve.mjs uses.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const candidate = join(out, specifier.slice(2) + ".js");
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const React = (await import("react")).default;
const { renderToStaticMarkup } = await import("react-dom/server");
const { QuestionText } = await import(
  pathToFileURL(join(out, "components", "QuestionText.js")).href
);

const html = (props) => renderToStaticMarkup(React.createElement(QuestionText, props));
const count = (s, re) => (s.match(re) ?? []).length;

/* ---------------- the ordinary question must be untouched ---------------- */

const plain = html({ text: "Which stage is reached on Day 5?", className: "q" });
check(
  "a one-line question is still a bare paragraph, as it always was",
  plain === '<p class="q">Which stage is reached on Day 5?</p>',
  plain,
);

/* ------------------------------ bullet lists ---------------------------- */

const bullets = html({
  text: "Which are true?\n- It forms on Day 5\n- It has an inner cell mass",
  className: "q",
});
check("the wording before the list stays a paragraph", bullets.includes("<p>Which are true?</p>"), bullets);
check("the dashes become one list", count(bullets, /<ul/g) === 1);
check("each dashed line becomes one item", count(bullets, /<li/g) === 2);
check("the list is drawn with discs", bullets.includes("list-disc"));
check("className lands on the wrapper, so sizing is inherited", bullets.startsWith('<div class="q">'));
check("the marker characters themselves never reach the page", !bullets.includes("- It forms"));

/* ----------------------------- numbered lists --------------------------- */

const numbers = html({ text: "Order these:\n1. Zygote\n2) Morula" });
check("numbered lines become one ordered list", count(numbers, /<ol/g) === 1);
check("the numbers are drawn, not repeated as text", !numbers.includes("1. Zygote"));
check("the list is drawn with numbers", numbers.includes("list-decimal"));

const mixed = html({ text: "Q?\n- a\n- b\n1. one\n2. two\nNow choose." });
check(
  "a bullet list and a numbered list stay two lists",
  count(mixed, /<ul/g) === 1 && count(mixed, /<ol/g) === 1,
  mixed,
);
check(
  "wording after a list is a paragraph of its own, with space above it",
  mixed.includes('<p class="mt-2">Now choose.</p>'),
  mixed,
);

/* ------------------- the numbering used on answer sheets ----------------- */

const prefixedPlain = html({ text: "One line only", prefix: "7." });
check(
  "a number on a one-line question reads as one sentence",
  prefixedPlain === "<p>7. One line only</p>",
  prefixedPlain,
);

const prefixed = html({ text: "Which are true?\n- a\n- b", prefix: "3." });
check("a number rides on the first line of a listed question", prefixed.includes("<p>3. Which are true?</p>"), prefixed);
check("and is not repeated further down", count(prefixed, /3\./g) === 1, prefixed);

const prefixedList = html({ text: "- a\n- b", prefix: "4." });
check(
  "a question that opens straight into a list still shows its number",
  prefixedList.includes("4."),
  prefixedList,
);

/* -------------------------------- escaping ------------------------------ */

const nasty = html({
  text: "Is <b>this</b> & that?\n- <script>alert(1)</script>\n- **bold**\n- <img src=x onerror=alert(1)>",
});
check("angle brackets in the wording are escaped", nasty.includes("&lt;b&gt;this&lt;/b&gt;"), nasty);
check("an ampersand is escaped", nasty.includes("&amp; that?"));
check("a script tag cannot survive as markup", !nasty.includes("<script"), nasty);
check("nor can an img with an onerror handler", !nasty.includes("<img"), nasty);
check("asterisks are left exactly as they were typed", nasty.includes("**bold**"));
check(
  "the only tags in the output are the ones the component chose",
  [...nasty.matchAll(/<\/?([a-z]+)/g)].every((m) => ["div", "p", "ul", "ol", "li", "br"].includes(m[1])),
  nasty,
);

/* ---------------------------- nothing at all ---------------------------- */

check("empty wording renders an empty paragraph, not a crash", html({ text: "" }) === "<p></p>");
check("wording that is only blank lines is empty too", html({ text: "\n\n  \n" }) === "<p></p>");
check("wording that is only a stray dash is text, not an empty bullet", html({ text: "-" }) === "<p>-</p>");

rmSync(out, { recursive: true, force: true });

console.log(`\n${failures ? "FAILED" : "All good"}: ${failures} failed\n`);
process.exit(failures ? 1 : 0);
