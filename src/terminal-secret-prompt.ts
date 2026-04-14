import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

export function terminalPromptAvailable(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

export async function promptTerminalText(question: string): Promise<string | undefined> {
  if (!terminalPromptAvailable()) {
    return undefined;
  }

  const terminal = createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
  });

  try {
    const answer = await terminal.question(question);
    const trimmed = answer.trim();
    return trimmed || undefined;
  } finally {
    terminal.close();
  }
}

export async function promptTerminalSecret(
  question: string,
  mask = "*",
): Promise<string | undefined> {
  if (!terminalPromptAvailable()) {
    return undefined;
  }

  return new Promise((resolve, reject) => {
    const previousRawMode = stdin.isRaw;
    let value = "";
    let settled = false;

    const cleanup = (next: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      stdin.off("data", onData);
      if (stdin.isTTY) {
        stdin.setRawMode(Boolean(previousRawMode));
      }
      stdin.pause();
      stdout.write("\n");
      next();
    };

    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const char of text) {
        if (char === "\u0003") {
          cleanup(() => reject(new Error("Terminal prompt cancelled.")));
          return;
        }

        if (char === "\r" || char === "\n") {
          const trimmed = value.trim();
          cleanup(() => resolve(trimmed || undefined));
          return;
        }

        if (char === "\u0008" || char === "\u007f") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            if (mask) {
              stdout.write("\b \b");
            }
          }
          continue;
        }

        if (char >= " ") {
          value += char;
          if (mask) {
            stdout.write(mask);
          }
        }
      }
    };

    stdout.write(question);
    stdin.resume();
    stdin.setEncoding("utf8");
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.on("data", onData);
  });
}
