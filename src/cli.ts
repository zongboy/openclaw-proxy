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

type Config = {
  listenAddr: string;
  listenHost?: string;
  listenPort: number;
  targetBaseURL: URL;
  injectHeader: string;
  injectValue: string;
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
const ENV_FILE = join(CONFIG_DIR, ".env");
const PID_FILE = join(CONFIG_DIR, "openclaw-proxy.pid");
const LOG_FILE = join(CONFIG_DIR, "openclaw-proxy.log");
const DEFAULT_ENV = `TARGET_BASE_URL="https://your-openclaw.example.com"
API_KEY="your-openclaw-key"
API_KEY_VALUE=""
API_KEY_HEADER="Authorization"
API_KEY_PREFIX="Bearer"
LISTEN_ADDR=":8080"
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
  ensureEnvFile();
  loadDotEnvIfPresent(ENV_FILE);
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
      `openclaw-proxy listening on ${config.listenAddr}, upstream=${config.targetBaseURL.toString()}, inject_header=${config.injectHeader}`
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
  ensureEnvFile();
  if (isRunning()) {
    console.log(`openclaw-proxy is already running, pid=${readPid()}`);
    return;
  }

  loadDotEnvIfPresent(ENV_FILE);
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
  console.log(`config: ${ENV_FILE}`);
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
    console.log(`config: ${ENV_FILE}`);
    return;
  }

  console.log(`openclaw-proxy is running, pid=${pid}`);
  console.log(`config: ${ENV_FILE}`);
  console.log(`log: ${LOG_FILE}`);
}

function restartCommand(): void {
  stopCommand();
  startCommand();
}

function initCommand(): void {
  ensureEnvFile();
  console.log(`config initialized: ${ENV_FILE}`);
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
  const incomingUrl = new URL(request.url ?? "/", "http://proxy.local");
  const upstreamUrl = new URL(config.targetBaseURL.toString());

  upstreamUrl.pathname = joinPath(config.targetBaseURL.pathname, incomingUrl.pathname);
  upstreamUrl.search = joinSearch(config.targetBaseURL.search, incomingUrl.search);

  const headers = cloneHeaders(request.headers);
  headers.host = upstreamUrl.host;
  headers[config.injectHeader.toLowerCase()] = config.injectValue;

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
      `request method=${request.method ?? "GET"} path=${incomingUrl.pathname}${incomingUrl.search} remote=${request.socket.remoteAddress ?? "unknown"}`
    );
  });

  request.pipe(upstreamRequest);
}

function loadConfig(): Config {
  const targetRaw = getEnvOrThrow("TARGET_BASE_URL");
  const targetBaseURL = new URL(targetRaw);
  if (!targetBaseURL.protocol || !targetBaseURL.host) {
    throw new Error("TARGET_BASE_URL must include scheme and host");
  }

  const injectHeader = getEnv("API_KEY_HEADER", "Authorization");
  const injectValue = buildInjectValue(injectHeader);
  if (!injectValue) {
    throw new Error("API_KEY or API_KEY_VALUE is required");
  }

  const listen = parseListenAddr(getEnv("LISTEN_ADDR", ":8080"));

  return {
    listenAddr: listen.display,
    listenHost: listen.host,
    listenPort: listen.port,
    targetBaseURL,
    injectHeader,
    injectValue
  };
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

  throw new Error("LISTEN_ADDR must be 8080, :8080, or 127.0.0.1:8080");
}

function buildInjectValue(headerName: string): string {
  const explicitValue = getEnv("API_KEY_VALUE", "");
  if (explicitValue) {
    return explicitValue;
  }

  const apiKey = getEnv("API_KEY", "");
  if (!apiKey) {
    return "";
  }

  let prefix = getEnv("API_KEY_PREFIX", "");
  if (!prefix && headerName.toLowerCase() === "authorization") {
    prefix = "Bearer";
  }

  return prefix ? `${prefix} ${apiKey}` : apiKey;
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

function getEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function getEnvOrThrow(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function loadDotEnvIfPresent(path: string): void {
  if (!existsSync(path)) {
    return;
  }

  const content = readFileSync(path, "utf8");
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalizedLine = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = normalizedLine.indexOf("=");
    if (separator <= 0) {
      throw new Error(`invalid .env line ${index + 1}`);
    }

    const key = normalizedLine.slice(0, separator).trim();
    let value = normalizedLine.slice(separator + 1).trim();
    value = stripWrappedQuotes(value);

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

function ensureEnvFile(): void {
  if (!existsSync(ENV_FILE)) {
    writeFileSync(ENV_FILE, DEFAULT_ENV, { encoding: "utf8", mode: 0o600 });
  }

  try {
    chmodSync(ENV_FILE, 0o600);
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

function stripWrappedQuotes(value: string): string {
  if (value.length >= 2) {
    const quote = value[0];
    const last = value[value.length - 1];
    if ((quote === '"' || quote === "'") && last === quote) {
      return value.slice(1, -1);
    }
  }
  return value;
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