import { createScryptPasswordHash } from "../src/web-auth";

const password = Bun.argv[2] ?? process.env.FLY_DESK_WEB_PASSWORD;

if (!password) {
  console.error("Usage: FLY_DESK_WEB_PASSWORD=<password> bun scripts/generate-web-password-hash.ts");
  process.exit(1);
}

console.log(createScryptPasswordHash(password));
