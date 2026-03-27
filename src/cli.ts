#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse
} from "node:http";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";

type RawProviderConfig = {
  name?: unknown;
  virtualApiKey?: unknown;
  targetBaseUrl?: unknown;
  apiKey?: unknown;
  apiKeyValue?: unknown;
  apiKeyHeader?: unknown;
  apiKeyPrefix?: unknown;
};

type RawConfigFile = {
  listenAddr?: unknown;
  providers?: unknown;
};

type ProviderConfig = {
  name: string;
  virtualApiKey: string;
  targetBaseURL: URL;
  injectHeader: string;
  injectValue: string;
};

type Config = {
  listenAddr: string;
  listenHost?: string;
  listenPort: number;
  providers: ProviderConfig[];
  providersByVirtualKey: Map<string, ProviderConfig>;
};

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const CONFIG_DIR = join(homedir(), ".openclaw-proxy");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const PID_FILE = join(CONFIG_DIR, "openclaw-proxy.pid");
const LOG_FILE = join(CONFIG_DIR, "openclaw-proxy.log");
const DEFAULT_CONFIG = `${JSON.stringify(
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

function main(): void {
  ensureConfigDir();

  const command = process.argv[2] ?? "help";
  switch (command) {
    case "start":
      startCommand();
      return;
    case "stop":
      stopCommand();
      return;
    case "status":
      statusCommand();
      return;
    case "restart":
      restartCommand();
      return;
    case "serve":
      serveCommand();
      return;
    case "init":
      initCommand();
      return;
    case "help":
    case "--help":
    case "-h":
      printUsage();
      return;
    default:
      console.error(`unknown command: ${command}`);
      printUsage();
      process.exitCode = 1;
  }
}

function serveCommand(): void {
  ensureConfigFile();
  const config = loadConfig();

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://proxy.local");
    if (requestUrl.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ok");
      return;
    }

    proxyRequest(config, request, response);
  });

  server.on("listening", () => {
    console.log(
      `openclaw-proxy listening on ${config.listenAddr}, config=${CONFIG_FILE}, providers=${config.providers.length}`
    );
  });

  server.on("error", (error) => {
    console.error(`server error: ${String(error)}`);
    process.exitCode = 1;
  });

  const cleanup = () => removePidFileIfOwned();
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("exit", cleanup);

  server.listen(config.listenPort, config.listenHost);
}

function startCommand(): void {
  ensureConfigFile();
  if (isRunning()) {
    console.log(`openclaw-proxy is already running, pid=${readPid()}`);
    return;
  }

  loadConfig();

  const cliPath = fileURLToPath(import.meta.url);
  const stdoutFd = openSync(LOG_FILE, "a", 0o600);
  const stderrFd = openSync(LOG_FILE, "a", 0o600);
  const child = spawn(process.execPath, [cliPath, "serve"], {
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
    env: process.env
  });

  child.on("error", (error) => {
    console.error(`failed to start: ${String(error)}`);
    process.exitCode = 1;
  });

  child.unref();
  closeSync(stdoutFd);
  closeSync(stderrFd);
  writeFileSync(PID_FILE, `${child.pid}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`openclaw-proxy started, pid=${child.pid}`);
  console.log(`config: ${CONFIG_FILE}`);
  console.log(`log: ${LOG_FILE}`);
}

function stopCommand(): void {
  const pid = readPid();
  if (!pid || !isProcessRunning(pid)) {
    removePidFileIfOwned();
    console.log("openclaw-proxy is not running");
    return;
  }

  process.kill(pid, "SIGTERM");
  removePidFileIfOwned();
  console.log(`openclaw-proxy stopped, pid=${pid}`);
}

function statusCommand(): void {
  const pid = readPid();
  if (!pid || !isProcessRunning(pid)) {
    removePidFileIfOwned();
    console.log("openclaw-proxy is not running");
    console.log(`config: ${CONFIG_FILE}`);
    return;
  }

  console.log(`openclaw-proxy is running, pid=${pid}`);
  console.log(`config: ${CONFIG_FILE}`);
  console.log(`log: ${LOG_FILE}`);
}

function restartCommand(): void {
  stopCommand();
  startCommand();
}

function initCommand(): void {
  ensureConfigFile();
  console.log(`config initialized: ${CONFIG_FILE}`);
}

function printUsage(): void {
  console.log(`Usage: openclaw-proxy <command>

Commands:
  start    Start proxy in background
  stop     Stop background proxy
  status   Show proxy status
  restart  Restart background proxy
  serve    Run proxy in foreground
  init     Create default config file
  help     Show this help
`);
}

function proxyRequest(config: Config, request: IncomingMessage, response: ServerResponse): void {
  const provider = selectProvider(config, request, response);
  if (!provider) {
    return;
  }

  const incomingUrl = new URL(request.url ?? "/", "http://proxy.local");
  const upstreamUrl = new URL(provider.targetBaseURL.toString());

  upstreamUrl.pathname = joinPath(provider.targetBaseURL.pathname, incomingUrl.pathname);
  upstreamUrl.search = joinSearch(provider.targetBaseURL.search, incomingUrl.search);

  const headers = cloneHeaders(request.headers);
  delete headers.authorization;
  headers.host = upstreamUrl.host;
  headers[provider.injectHeader.toLowerCase()] = provider.injectValue;

  const options: RequestOptions = {
    protocol: upstreamUrl.protocol,
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || undefined,
    method: request.method,
    path: upstreamUrl.pathname + upstreamUrl.search,
    headers
  };

  const send = upstreamUrl.protocol === "https:" ? httpsRequest : httpRequest;
  const upstreamRequest = send(options, (upstreamResponse) => {
    const responseHeaders = filterResponseHeaders(upstreamResponse.headers);
    responseHeaders["x-proxy-by"] = "openclaw-proxy";

    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(response);
    upstreamResponse.on("error", (error) => {
      console.error(`upstream response error: ${String(error)}`);
      response.destroy(error);
    });
  });

  upstreamRequest.on("error", (error) => {
    console.error(`proxy error: method=${request.method ?? "GET"} path=${incomingUrl.pathname} err=${String(error)}`);
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    response.end("bad gateway");
  });

  request.on("aborted", () => upstreamRequest.destroy());
  response.on("finish", () => {
    console.log(
      `request provider=${provider.name} method=${request.method ?? "GET"} path=${incomingUrl.pathname}${incomingUrl.search} remote=${request.socket.remoteAddress ?? "unknown"}`
    );
  });

  request.pipe(upstreamRequest);
}

function loadConfig(): Config {
  const configRaw = readConfigFile(CONFIG_FILE);
  const listen = parseListenAddr(readOptionalString(configRaw.listenAddr, "listenAddr") || "127.0.0.1:8080");
  const rawProviders = readProviders(configRaw.providers);
  const providers = rawProviders.map((provider, index) => normalizeProvider(provider, index));
  const providersByVirtualKey = new Map<string, ProviderConfig>();

  for (const provider of providers) {
    if (providersByVirtualKey.has(provider.virtualApiKey)) {
      throw new Error(`duplicate virtualApiKey: ${provider.virtualApiKey}`);
    }
    providersByVirtualKey.set(provider.virtualApiKey, provider);
  }

  return {
    listenAddr: listen.display,
    listenHost: listen.host,
    listenPort: listen.port,
    providers,
    providersByVirtualKey
  };
}

function readConfigFile(path: string): RawConfigFile {
  const content = readFileSync(path, "utf8");
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`invalid config.json: ${String(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config.json must contain a JSON object");
  }

  return parsed as RawConfigFile;
}

function readProviders(value: unknown): RawProviderConfig[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("config.json providers must be a non-empty array");
  }

  return value as RawProviderConfig[];
}

function parseListenAddr(raw: string): { display: string; host?: string; port: number } {
  const value = raw.trim();
  if (/^\d+$/.test(value)) {
    return { display: value, port: Number(value) };
  }
  if (/^:\d+$/.test(value)) {
    return { display: value, port: Number(value.slice(1)) };
  }

  const separator = value.lastIndexOf(":");
  if (separator > 0) {
    const host = value.slice(0, separator).trim();
    const port = Number(value.slice(separator + 1));
    if (host && Number.isInteger(port) && port > 0) {
      return { display: value, host, port };
    }
  }

  throw new Error("listenAddr must be 8080, :8080, or 127.0.0.1:8080");
}

function normalizeProvider(rawProvider: RawProviderConfig, index: number): ProviderConfig {
  if (!rawProvider || typeof rawProvider !== "object" || Array.isArray(rawProvider)) {
    throw new Error(`providers[${index}] must be an object`);
  }

  const name = readRequiredString(rawProvider.name, `providers[${index}].name`);
  const virtualApiKey = readRequiredString(rawProvider.virtualApiKey, `providers[${index}].virtualApiKey`);
  const targetRaw = readRequiredString(rawProvider.targetBaseUrl, `providers[${index}].targetBaseUrl`);
  const targetBaseURL = new URL(targetRaw);
  if (!targetBaseURL.protocol || !targetBaseURL.host) {
    throw new Error(`providers[${index}].targetBaseUrl must include scheme and host`);
  }

  const injectHeader = readOptionalString(rawProvider.apiKeyHeader, `providers[${index}].apiKeyHeader`) || "Authorization";
  const injectValue = buildInjectValue(rawProvider, injectHeader, index);
  if (!injectValue) {
    throw new Error(`providers[${index}] apiKey or apiKeyValue is required`);
  }

  return {
    name,
    virtualApiKey,
    targetBaseURL,
    injectHeader,
    injectValue
  };
}

function buildInjectValue(rawProvider: RawProviderConfig, headerName: string, index: number): string {
  const explicitValue = readOptionalString(rawProvider.apiKeyValue, `providers[${index}].apiKeyValue`) || "";
  if (explicitValue) {
    return explicitValue;
  }

  const apiKey = readOptionalString(rawProvider.apiKey, `providers[${index}].apiKey`) || "";
  if (!apiKey) {
    return "";
  }

  let prefix = readOptionalString(rawProvider.apiKeyPrefix, `providers[${index}].apiKeyPrefix`) || "";
  if (!prefix && headerName.toLowerCase() === "authorization") {
    prefix = "Bearer";
  }

  return prefix ? `${prefix} ${apiKey}` : apiKey;
}

function selectProvider(config: Config, request: IncomingMessage, response: ServerResponse): ProviderConfig | null {
  const virtualApiKey = readVirtualApiKey(request.headers.authorization);
  if (!virtualApiKey) {
    writeErrorResponse(response, 401, "missing authorization virtual api-key");
    return null;
  }

  const provider = config.providersByVirtualKey.get(virtualApiKey);
  if (!provider) {
    writeErrorResponse(response, 403, "unknown authorization virtual api-key");
    return null;
  }

  return provider;
}

function readVirtualApiKey(headerValue: string | string[] | undefined): string {
  const rawValue = Array.isArray(headerValue) ? headerValue.find((value) => value.trim()) : headerValue;
  if (!rawValue) {
    return "";
  }

  const trimmed = rawValue.trim();
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (bearerMatch) {
    return bearerMatch[1].trim();
  }

  return trimmed;
}

function writeErrorResponse(response: ServerResponse, statusCode: number, message: string): void {
  response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}

function cloneHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const cloned: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(key)) {
      continue;
    }
    cloned[key] = value;
  }
  return cloned;
}

function filterResponseHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const filtered: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(key)) {
      continue;
    }
    filtered[key] = value;
  }
  return filtered;
}

function readRequiredString(value: unknown, fieldName: string): string {
  const normalized = readOptionalString(value, fieldName);
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
}

function readOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }

  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

function ensureConfigFile(): void {
  if (!existsSync(CONFIG_FILE)) {
    writeFileSync(CONFIG_FILE, DEFAULT_CONFIG, { encoding: "utf8", mode: 0o600 });
  }

  try {
    chmodSync(CONFIG_FILE, 0o600);
  } catch {
  }
}

function readPid(): number | null {
  if (!existsSync(PID_FILE)) {
    return null;
  }

  const content = readFileSync(PID_FILE, "utf8").trim();
  if (!/^\d+$/.test(content)) {
    return null;
  }

  return Number(content);
}

function isRunning(): boolean {
  const pid = readPid();
  return pid !== null && isProcessRunning(pid);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removePidFileIfOwned(): void {
  const pid = readPid();
  if (pid !== null && pid !== process.pid && isProcessRunning(pid)) {
    return;
  }

  if (existsSync(PID_FILE)) {
    unlinkSync(PID_FILE);
  }
}

function joinPath(basePath: string, requestPath: string): string {
  const left = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const right = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
  const joined = `${left}${right}`;
  return joined || "/";
}

function joinSearch(baseSearch: string, requestSearch: string): string {
  if (!baseSearch) {
    return requestSearch;
  }
  if (!requestSearch) {
    return baseSearch;
  }
  return `${baseSearch}&${requestSearch.slice(1)}`;
}

main();