import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";

export type LocalBrowserPreference = "chrome" | "default";

interface OpenUrlResult {
  launcher: "chrome" | "default";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
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
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });

  child.unref();
}

async function openWithDefaultBrowser(targetUrl: string): Promise<void> {
  switch (process.platform) {
    case "win32":
      spawnDetached("cmd.exe", ["/c", "start", "", targetUrl]);
      return;
    case "darwin":
      spawnDetached("open", [targetUrl]);
      return;
    default:
      spawnDetached("xdg-open", [targetUrl]);
  }
}

export async function openUrlLocally(
  targetUrl: string,
  preferredBrowser: LocalBrowserPreference,
): Promise<OpenUrlResult> {
  if (preferredBrowser === "chrome") {
    const chromeExecutable = await findChromeExecutable();
    if (chromeExecutable) {
      spawnDetached(chromeExecutable, ["--new-tab", targetUrl]);
      return { launcher: "chrome" };
    }
  }

  await openWithDefaultBrowser(targetUrl);
  return { launcher: "default" };
}
