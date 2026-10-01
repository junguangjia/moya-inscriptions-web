#!/usr/bin/env node
/**
 * Prepares the email-auth-v1 acceptance notes for this worktree.
 * It does not migrate a retained database, start a sibling task, or send
 * external mail. Mailpit, when started, binds to loopback.
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const profile = process.argv.includes("--email-first")
  ? "email-first"
  : "full-local";
const ports = {
  web: 3460,
  backend: 3461,
  mailpitUi: 3463,
  mailpitSmtp: 3464,
  postgres: 54370,
};

const free = (port) =>
  new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });

const key = () => randomBytes(32).toString("base64");
const lines = [
  "NODE_ENV=development",
  `AUTH_PROFILE=${profile}`,
  "AUTH_KEY_VERSION=1",
  `AUTH_LOOKUP_KEY=${key()}`,
  `AUTH_ENCRYPTION_KEY=${key()}`,
  `AUTH_OTP_KEY=${key()}`,
  `AUTH_EMAIL_CAPTURE_URL=http://127.0.0.1:${ports.mailpitUi}`,
  "MOYA_CONTENT_SOURCE=payload",
];

const envDir = path.join(root, ".local");
await mkdir(envDir, { recursive: true });
const envFile = path.join(envDir, "email-auth.env");
await writeFile(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });

const availability = {};
for (const [name, port] of Object.entries(ports))
  availability[name] = await free(port);

console.log(
  JSON.stringify(
    {
      profile,
      envFile: ".local/email-auth.env",
      ports,
      portFree: availability,
      mailpit:
        "docker run --rm -p 127.0.0.1:3463:8025 -p 127.0.0.1:3464:1025 axllent/mailpit",
      web: "http://127.0.0.1:3460/login",
      inbox: "http://127.0.0.1:3463",
      note: "Keys were written only to the gitignored .local file. Do not print them.",
    },
    null,
    2,
  ),
);
