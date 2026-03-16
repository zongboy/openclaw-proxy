import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const configDir = join(homedir(), ".openclaw-proxy");
const envFile = join(configDir, ".env");
const defaultEnv = `TARGET_BASE_URL="https://your-openclaw.example.com"
API_KEY="your-openclaw-key"
API_KEY_VALUE=""
API_KEY_HEADER="Authorization"
API_KEY_PREFIX="Bearer"
LISTEN_ADDR=":8080"
`;

mkdirSync(configDir, { recursive: true, mode: 0o700 });

if (!existsSync(envFile)) {
  writeFileSync(envFile, defaultEnv, { encoding: "utf8", mode: 0o600 });
}

try {
  chmodSync(envFile, 0o600);
} catch {
}

console.log(`openclaw-proxy config ready: ${envFile}`);