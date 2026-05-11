import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";

const rootDir = process.cwd();
const frontendDir = resolve(rootDir, "frontend");
const distDir = join(frontendDir, "dist");
const publicDir = join(frontendDir, "public");
const templatePath = join(frontendDir, "index.html");

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(frontendDir, "src", "main.tsx")],
  outdir: distDir,
  target: "browser",
  minify: true,
  sourcemap: "none",
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
