import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";

const cwd = process.cwd();
const isFrontendWorkspace =
  existsSync(join(cwd, "index.html")) && existsSync(join(cwd, "src", "main.tsx"));
const frontendDir = isFrontendWorkspace ? cwd : resolve(cwd, "frontend");
const distDir = join(frontendDir, "dist");
const assetsDir = join(distDir, "assets");
const publicDir = join(frontendDir, "public");
const templatePath = join(frontendDir, "index.html");

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

/* React picks its development or production build from a bare
   `process.env.NODE_ENV` test, and Bun would otherwise inline the ambient value
   (usually unset, so "development"). A local development bundle asks for it. */
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

/* Fonts are served from this origin. Bun's CSS bundler inlines every `url()` as
   a data URI, so the faces are copied here instead and declared inline in the
   document, where the browser finds them before the stylesheet has arrived. */
const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

type WebFont = {
  family: string;
  weight: string;
  source: string;
  range: string;
  /** Preloaded because the first screen cannot be drawn without it. */
  preload?: "sans";
};

/* One family, Inter, for text and figures alike. */
const FONT_FACES: WebFont[] = [
  { family: "Inter", weight: "100 900", source: "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2", range: LATIN, preload: "sans" },
  { family: "Inter", weight: "100 900", source: "@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2", range: LATIN_EXT },
];

/* Local faces sized to the web font's advance and vertical metrics (measured in
   Chromium), so the swap moves text as little as possible. Arial covers
   Windows. */
const FALLBACK_FACES = [
  `@font-face{font-family:"Inter Fallback";font-weight:100 500;src:local("Arial"),local("ArialMT");size-adjust:103.95%;ascent-override:93.19%;descent-override:23.2%;line-gap-override:0%}`,
  `@font-face{font-family:"Inter Fallback";font-weight:600 900;src:local("Arial Bold"),local("Arial-BoldMT");size-adjust:100.26%;ascent-override:96.62%;descent-override:24.06%;line-gap-override:0%}`,
];

function emitFont(source: string): string {
  const file = Bun.resolveSync(source, frontendDir);
  const bytes = readFileSync(file);
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 10);
  const name = `${basename(file, ".woff2")}-${hash}.woff2`;
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, name), bytes);
  return `/assets/${name}`;
}

const fontRules: string[] = [];
const fontPreloads: string[] = [];
for (const face of FONT_FACES) {
  const href = emitFont(face.source);
  fontRules.push(
    `@font-face{font-family:"${face.family}";font-style:normal;font-weight:${face.weight};font-display:swap;src:url(${href}) format("woff2");unicode-range:${face.range}}`,
  );
  if (face.preload) {
    fontPreloads.push(
      `    <link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin data-fd-font="${face.preload}" />`,
    );
  }
}
const fontHead = [
  ...fontPreloads,
  `    <style data-fd-fonts>${[...fontRules, ...FALLBACK_FACES].join("")}</style>`,
].join("\n");

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

const FONT_PLACEHOLDER = "    <!-- __FLYDESK_FONTS__ -->";
if (!template.includes(FONT_PLACEHOLDER)) {
  console.error("index.html has no font placeholder.");
  process.exit(1);
}
const templateWithFonts = template.replace(FONT_PLACEHOLDER, fontHead);
const templateWithStyles = stylesheetTags
  ? templateWithFonts.replace("  </head>", `${stylesheetTags}\n  </head>`)
  : templateWithFonts;
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
