import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";

const cwd = process.cwd();
const isFrontendWorkspace =
  existsSync(join(cwd, "index.html")) && existsSync(join(cwd, "src", "main.tsx"));
const frontendDir = isFrontendWorkspace ? cwd : resolve(cwd, "frontend");
const distDir = join(frontendDir, "dist");
const publicDir = join(frontendDir, "public");
const templatePath = join(frontendDir, "index.html");

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

/* React ships two copies of itself and chooses between them with a bare
   `process.env.NODE_ENV === "production"` test inside its CommonJS entry
   points (`react/index.js`, `react-dom/client.js`, `react/jsx-runtime.js`).
   Its `exports` map has no development/production condition — only
   `react-server` — so neither `conditions` nor `env` can reach that switch:
   substituting the literal is the only thing that moves it.

   Bun inlines the *ambient* `process.env.NODE_ENV` into browser bundles and
   falls back to "development" when the shell has none. Neither the deploy
   workflow nor `bun run build` sets it, so without the line below the
   released bundle is `react.development.js`: every development-only warning
   shipped to users, `StrictMode` double-invoking effects in production,
   error messages kept as full strings instead of collapsing to codes, and
   236 KB of dead instrumentation that `minify` only compresses. `minify`
   does not imply production — this is the flag that does.

   The bundle is therefore a production one unless `NODE_ENV=development`
   asks for the other, which is how a local `frontend/dist` keeps its
   warnings. The frontend dev server (`bun ./index.html`) never runs this
   script and is unaffected. */
const nodeEnv = process.env.NODE_ENV === "development" ? "development" : "production";

const result = await Bun.build({
  entrypoints: [join(frontendDir, "src", "main.tsx")],
  outdir: distDir,
  target: "browser",
  minify: true,
  sourcemap: "none",
  define: {
    "process.env.NODE_ENV": JSON.stringify(nodeEnv),
  },
  plugins: [tailwind],
  naming: {
    entry: "assets/[name]-[hash].[ext]",
    chunk: "assets/[name]-[hash].[ext]",
    asset: "assets/[name]-[hash].[ext]",
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

function publicAssetPath(outputPath: string): string {
  return `/${relative(distDir, outputPath).replaceAll("\\", "/")}`;
}

const entryScript = result.outputs.find((output) =>
  output.kind === "entry-point" && output.path.endsWith(".js")
);
if (!entryScript) {
  console.error("Bun build did not emit a JavaScript entrypoint.");
  process.exit(1);
}

const stylesheetTags = result.outputs
  .filter((output) => output.type.startsWith("text/css"))
  .map((output) => `    <link rel="stylesheet" crossorigin href="${publicAssetPath(output.path)}" />`)
  .join("\n");
const scriptTag = `    <script type="module" crossorigin src="${publicAssetPath(entryScript.path)}"></script>`;
const template = await Bun.file(templatePath).text();
const templateWithStyles = stylesheetTags
  ? template.replace("  </head>", `${stylesheetTags}\n  </head>`)
  : template;
const html = templateWithStyles.replace(
  /    <script type="module" src="\.?\/src\/main\.tsx"><\/script>/,
  scriptTag,
);

if (html === templateWithStyles) {
  console.error("Could not replace frontend entrypoint script in index.html.");
  process.exit(1);
}

if (existsSync(publicDir)) {
  cpSync(publicDir, distDir, { recursive: true });
}

await Bun.write(join(distDir, "index.html"), html);
