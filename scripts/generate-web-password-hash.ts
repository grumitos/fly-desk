import { createScryptPasswordHash } from "../src/web-auth";
import { promptTerminalSecret, terminalPromptAvailable } from "../src/terminal-secret-prompt";

function stripPipedLineEnding(value: string): string {
  const withoutLineEnding = value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n") || value.endsWith("\r")
      ? value.slice(0, -1)
      : value;
  if (withoutLineEnding.includes("\n") || withoutLineEnding.includes("\r")) {
    throw new Error("Password input must be a single line.");
  }
  return withoutLineEnding;
}

if (Bun.argv.length > 2 || process.env.FLY_DESK_WEB_PASSWORD !== undefined) {
  console.error("Plaintext password arguments and environment variables are not accepted.");
  process.exit(1);
}

let password: string | undefined;
if (process.stdin.isTTY) {
  if (!terminalPromptAvailable()) {
    console.error("A terminal is required for interactive password input.");
    process.exit(1);
  }
  password = await promptTerminalSecret("Web password: ", "");
} else {
  password = stripPipedLineEnding(await Bun.stdin.text());
}

if (!password) {
  console.error("No password was provided through the hidden prompt or standard input.");
  process.exit(1);
}

console.log(createScryptPasswordHash(password));
