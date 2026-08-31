/* Stylesheets are imported for their side effect — the bundler collects them
   and emits one file — and TypeScript has no idea what a `.css` import
   resolves to. Without this line the three modules that import one
   (`main.tsx`, `results/ResultCard.tsx`) fail
   with TS2882.

   It was called `vite-env.d.ts` until 2026-08-26, which named a bundler this
   repo has never used: the frontend is built by `scripts/build-frontend.ts`
   through `Bun.build`. The name is the only thing that pointed at Vite. */
declare module "*.css";
