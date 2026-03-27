import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const configDir = join(homedir(), ".openclaw-proxy");
const configFile = join(configDir, "config.json");
const defaultConfig = `${JSON.stringify(
  {
    listenAddr: "127.0.0.1:8080",
    providers: [
      {
        name: "aliyuncs",
        virtualApiKey: "proxy-aliyuncs-demo",
        targetBaseUrl: "https://your-openclaw.example.com/v1",
        apiKey: "your-real-api-key",
        apiKeyValue: "",
        apiKeyHeader: "Authorization",
        apiKeyPrefix: "Bearer"
      }
    ]
  },
  null,
  2
)}
`;

mkdirSync(configDir, { recursive: true, mode: 0o700 });

if (!existsSync(configFile)) {
  writeFileSync(configFile, defaultConfig, { encoding: "utf8", mode: 0o600 });
}

try {
  chmodSync(configFile, 0o600);
} catch {
}

console.log(`openclaw-proxy config ready: ${configFile}`);