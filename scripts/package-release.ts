import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

interface PackageReleaseOptions {
  rootDir: string;
  outputDir: string;
  platform: string;
}

interface CliOptions {
  rootDir?: string;
  outputDir?: string;
  platform?: string;
}

function readPackageVersion(rootDir: string): string {
  const packageJsonPath = join(rootDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: string;
  };
  const version = packageJson.version?.trim();
  if (!version) {
    throw new Error(`Missing package version in ${packageJsonPath}`);
  }
  return version;
}

function assertPathExists(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(`Missing ${label}: ${path}`);
  }
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPowerShell(command: string): void {
  const result = Bun.spawnSync([
    "powershell.exe",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(
      [
        "PowerShell archive command failed.",
        result.stdout.toString().trim(),
        result.stderr.toString().trim(),
      ].filter(Boolean).join("\n"),
    );
  }
}

function parseCliArgs(args: string[]): CliOptions {
  const options: CliOptions = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--root" && next) {
      options.rootDir = next;
      index += 1;
      continue;
    }

    if (arg === "--out" && next) {
      options.outputDir = next;
      index += 1;
      continue;
    }

    if (arg === "--platform" && next) {
      options.platform = next;
      index += 1;
      continue;
    }

    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  return options;
}

export function packageRelease(options: PackageReleaseOptions): string {
  const rootDir = resolve(options.rootDir);
  const outputDir = resolve(options.outputDir);
  const platform = options.platform;
  const version = readPackageVersion(rootDir);
  const executablePath = join(rootDir, "bin", "fly-desk.exe");
  const frontendDistDir = join(rootDir, "frontend", "dist");
  const frontendIndexPath = join(frontendDistDir, "index.html");

  assertPathExists(executablePath, "compiled executable");
  assertPathExists(frontendIndexPath, "frontend dist index");

  mkdirSync(outputDir, { recursive: true });
  const stagingParent = join(outputDir, ".package-staging");
  const releaseRoot = join(stagingParent, "fly-desk-release");
  rmSync(stagingParent, { recursive: true, force: true });
  mkdirSync(join(releaseRoot, "bin"), { recursive: true });
  mkdirSync(join(releaseRoot, "frontend"), { recursive: true });

  cpSync(executablePath, join(releaseRoot, "bin", "fly-desk.exe"));
  cpSync(frontendDistDir, join(releaseRoot, "frontend", "dist"), {
    recursive: true,
  });

  const releaseJson = {
    schemaVersion: 1,
    appId: "fly-desk",
    version,
    platform,
    builtAt: new Date().toISOString(),
    executable: "bin/fly-desk.exe",
    publicDir: "frontend/dist",
  };
  writeFileSync(
    join(releaseRoot, "release.json"),
    `${JSON.stringify(releaseJson, null, 2)}\n`,
  );

  const zipPath = join(outputDir, `fly-desk-windows-x64-v${version}.zip`);
  rmSync(zipPath, { force: true });
  mkdirSync(dirname(zipPath), { recursive: true });
  runPowerShell(
    [
      `$source = ${powershellQuote(releaseRoot)}`,
      `$destination = ${powershellQuote(zipPath)}`,
      "Compress-Archive -LiteralPath $source -DestinationPath $destination -Force",
    ].join("; "),
  );
  rmSync(stagingParent, { recursive: true, force: true });
  return zipPath;
}

if (import.meta.main) {
  try {
    const cliOptions = parseCliArgs(Bun.argv.slice(2));
    const zipPath = packageRelease({
      rootDir: cliOptions.rootDir ?? process.cwd(),
      outputDir: cliOptions.outputDir ?? join(process.cwd(), "artifacts", "release"),
      platform: cliOptions.platform ?? "windows-x64",
    });
    console.log(zipPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
