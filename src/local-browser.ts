export type LocalBrowserPreference = "chrome" | "default";

export interface ChromeLaunchOptions {
  userDataDir?: string;
  profileDirectory?: string;
}

export interface OpenUrlResult {
  launcher: "chrome" | "default";
}

export interface BrowserLaunchInvocation {
  command: string;
  args: string[];
}

async function fileExists(filePath: string): Promise<boolean> {
  return Bun.file(filePath).exists();
}

async function findChromeExecutable(): Promise<string | undefined> {
  const candidates = [
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env.PROGRAMFILES && `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env["PROGRAMFILES(X86)"] && `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function spawnDetached(command: string, args: string[]): void {
  const child = Bun.spawn([command, ...args], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });

  child.unref();
}

function buildDefaultBrowserLaunchInvocation(
  targetUrl: string,
  platform: typeof process.platform = process.platform,
): BrowserLaunchInvocation {
  switch (platform) {
    case "win32":
      return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", targetUrl] };
    case "darwin":
      return { command: "open", args: [targetUrl] };
    default:
      return { command: "xdg-open", args: [targetUrl] };
  }
}

export function buildDefaultBrowserLaunchInvocationForTests(
  targetUrl: string,
  platform: typeof process.platform = process.platform,
): BrowserLaunchInvocation {
  return buildDefaultBrowserLaunchInvocation(targetUrl, platform);
}

async function openWithDefaultBrowser(targetUrl: string): Promise<void> {
  const invocation = buildDefaultBrowserLaunchInvocation(targetUrl);
  spawnDetached(invocation.command, invocation.args);
}

function buildChromeLaunchArgs(targetUrl: string, options?: ChromeLaunchOptions): string[] {
  const args: string[] = [];
  const userDataDir = options?.userDataDir?.trim();
  const profileDirectory = options?.profileDirectory?.trim();

  if (userDataDir) {
    args.push(`--user-data-dir=${userDataDir}`);
  }

  if (profileDirectory) {
    args.push(`--profile-directory=${profileDirectory}`);
  }

  args.push("--new-tab", targetUrl);
  return args;
}

export async function openUrlLocally(
  targetUrl: string,
  preferredBrowser: LocalBrowserPreference,
  chromeOptions?: ChromeLaunchOptions,
): Promise<OpenUrlResult> {
  if (preferredBrowser === "chrome") {
    const chromeExecutable = await findChromeExecutable();
    if (chromeExecutable) {
      spawnDetached(chromeExecutable, buildChromeLaunchArgs(targetUrl, chromeOptions));
      return { launcher: "chrome" };
    }
  }

  await openWithDefaultBrowser(targetUrl);
  return { launcher: "default" };
}
