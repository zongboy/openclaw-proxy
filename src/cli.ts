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
import { homedir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import { WebSocket, WebSocketServer, createWebSocketStream } from "ws";

type RawProviderConfig = {
  name?: unknown;
  virtualApiKey?: unknown;
  virtualApiKeys?: unknown;
  targetBaseUrl?: unknown;
  apiKey?: unknown;
};

type RawConfigFile = {
  listenAddr?: unknown;
  providers?: unknown;
};

type CredentialType = "authorization" | "header" | "query";
type CredentialScheme = "bearer" | "raw";

type RequestCredential = {
  value: string;
  rawValue: string;
  type: CredentialType;
  name?: string;
  scheme: CredentialScheme;
  label: string;
};

type ProviderConfig = {
  name: string;
  virtualApiKeys: string[];
  targetBaseURL: URL;
  apiKey: string;
};

type Config = {
  listenAddr: string;
  listenHost?: string;
  listenPort: number;
  providers: ProviderConfig[];
};

type ProviderSelection = {
  provider: ProviderConfig;
  matchedCredential: RequestCredential;
  virtualApiKey: string;
};

type ProviderSelectionResult = {
  selection: ProviderSelection | null;
  statusCode: number;
  message: string;
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

const WEBSOCKET_HANDSHAKE_HEADERS = [
  "host",
  "sec-websocket-accept",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version"
];

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
        targetBaseUrl: "https://your-openclaw.example.com",
        apiKey: "your-real-api-key"
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
  const webSocketServer = new WebSocketServer({ noServer: true });

  webSocketServer.on("headers", (headers: string[]) => {
    headers.push("x-proxy-by: openclaw-proxy");
  });

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://proxy.local");
    if (requestUrl.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ok");
      return;
    }

    proxyRequest(config, request, response);
  });

  server.on("upgrade", (request, socket, head) => {
    proxyWebSocket(config, webSocketServer, request, socket, head);
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
  const result = selectProvider(config, request);
  if (!result.selection) {
    writeErrorResponse(response, result.statusCode, result.message);
    return;
  }

  const { provider, matchedCredential } = result.selection;
  const incomingUrl = new URL(request.url ?? "/", "http://proxy.local");
  const upstreamUrl = buildUpstreamUrl(provider, incomingUrl, result.selection, false);
  const headers = buildUpstreamHeaders(request.headers, result.selection, upstreamUrl.host, false);

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
    console.error(
      `proxy error: provider=${provider.name} source=${matchedCredential.label} method=${request.method ?? "GET"} path=${incomingUrl.pathname} err=${String(error)}`
    );
    if (!response.headersSent) {
      writeErrorResponse(response, 502, "bad gateway");
      return;
    }
    response.end();
  });

  request.on("aborted", () => upstreamRequest.destroy());
  response.on("finish", () => {
    console.log(
      `request provider=${provider.name} source=${matchedCredential.label} method=${request.method ?? "GET"} path=${incomingUrl.pathname}${incomingUrl.search} remote=${request.socket.remoteAddress ?? "unknown"}`
    );
  });

  request.pipe(upstreamRequest);
}

function proxyWebSocket(
  config: Config,
  webSocketServer: WebSocketServer,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  const result = selectProvider(config, request);
  if (!result.selection) {
    writeUpgradeError(socket, result.statusCode, result.message);
    return;
  }

  const { provider, matchedCredential } = result.selection;
  const incomingUrl = new URL(request.url ?? "/", "http://proxy.local");
  const upstreamUrl = buildUpstreamUrl(provider, incomingUrl, result.selection, true);
  const headers = buildUpstreamHeaders(request.headers, result.selection, upstreamUrl.host, true);
  const protocols = parseWebSocketProtocols(request.headers["sec-websocket-protocol"]);
  const upstreamWebSocket = new WebSocket(upstreamUrl, protocols.length > 0 ? protocols : undefined, { headers });
  let settled = false;

  socket.on("error", (error) => {
    console.error(`websocket client socket error: ${String(error)}`);
    upstreamWebSocket.terminate();
  });

  upstreamWebSocket.once("unexpected-response", (_upstreamRequest: IncomingMessage, upstreamResponse: IncomingMessage) => {
    if (!settled && !socket.destroyed) {
      settled = true;
      writeUpgradeError(
        socket,
        upstreamResponse.statusCode ?? 502,
        `upstream websocket rejected: ${upstreamResponse.statusMessage || "bad gateway"}`
      );
    }
    upstreamWebSocket.terminate();
  });

  upstreamWebSocket.once("error", (error: Error) => {
    console.error(
      `websocket upstream error: provider=${provider.name} source=${matchedCredential.label} path=${incomingUrl.pathname}${incomingUrl.search} err=${String(error)}`
    );
    if (!settled && !socket.destroyed) {
      settled = true;
      writeUpgradeError(socket, 502, "bad gateway");
    }
  });

  upstreamWebSocket.once("open", () => {
    if (socket.destroyed) {
      upstreamWebSocket.close();
      return;
    }
    settled = true;
    webSocketServer.handleUpgrade(request, socket, head, (clientWebSocket: WebSocket) => {
      bridgeWebSockets(
        clientWebSocket,
        upstreamWebSocket,
        provider.name,
        matchedCredential.label,
        incomingUrl.pathname + incomingUrl.search
      );
    });
  });
}

function bridgeWebSockets(
  clientWebSocket: WebSocket,
  upstreamWebSocket: WebSocket,
  providerName: string,
  sourceLabel: string,
  path: string
): void {
  const clientStream = createWebSocketStream(clientWebSocket);
  const upstreamStream = createWebSocketStream(upstreamWebSocket);

  clientStream.pipe(upstreamStream);
  upstreamStream.pipe(clientStream);

  clientWebSocket.on("error", (error: Error) => {
    console.error(`websocket client error: provider=${providerName} source=${sourceLabel} path=${path} err=${String(error)}`);
    upstreamWebSocket.terminate();
  });

  upstreamWebSocket.on("error", (error: Error) => {
    console.error(`websocket upstream error: provider=${providerName} source=${sourceLabel} path=${path} err=${String(error)}`);
    clientWebSocket.terminate();
  });

  clientStream.on("error", (error: Error) => {
    console.error(`websocket client stream error: provider=${providerName} source=${sourceLabel} path=${path} err=${String(error)}`);
    upstreamWebSocket.terminate();
  });

  upstreamStream.on("error", (error: Error) => {
    console.error(`websocket upstream stream error: provider=${providerName} source=${sourceLabel} path=${path} err=${String(error)}`);
    clientWebSocket.terminate();
  });

  clientWebSocket.on("close", () => {
    if (upstreamWebSocket.readyState === WebSocket.OPEN || upstreamWebSocket.readyState === WebSocket.CONNECTING) {
      upstreamWebSocket.close();
    }
  });

  upstreamWebSocket.on("close", () => {
    if (clientWebSocket.readyState === WebSocket.OPEN || clientWebSocket.readyState === WebSocket.CONNECTING) {
      clientWebSocket.close();
    }
    console.log(`websocket provider=${providerName} source=${sourceLabel} path=${path}`);
  });
}

function loadConfig(): Config {
  const configRaw = readConfigFile(CONFIG_FILE);
  const listen = parseListenAddr(readOptionalString(configRaw.listenAddr, "listenAddr") || "127.0.0.1:8080");
  const rawProviders = readProviders(configRaw.providers);
  const providers = rawProviders.map((provider, index) => normalizeProvider(provider, index));
  const virtualKeys = new Map<string, string>();

  for (const provider of providers) {
    for (const virtualApiKey of provider.virtualApiKeys) {
      const previousProvider = virtualKeys.get(virtualApiKey);
      if (previousProvider) {
        throw new Error(`duplicate virtualApiKey: ${virtualApiKey} (${previousProvider}, ${provider.name})`);
      }
      virtualKeys.set(virtualApiKey, provider.name);
    }
  }

  return {
    listenAddr: listen.display,
    listenHost: listen.host,
    listenPort: listen.port,
    providers
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
  const legacyVirtualApiKey = readOptionalString(rawProvider.virtualApiKey, `providers[${index}].virtualApiKey`);
  const virtualApiKeys = new Set(readStringArray(rawProvider.virtualApiKeys, `providers[${index}].virtualApiKeys`));
  if (legacyVirtualApiKey) {
    virtualApiKeys.add(legacyVirtualApiKey);
  }
  if (virtualApiKeys.size === 0) {
    throw new Error(`providers[${index}].virtualApiKey or providers[${index}].virtualApiKeys is required`);
  }

  const targetRaw = readRequiredString(rawProvider.targetBaseUrl, `providers[${index}].targetBaseUrl`);
  const targetBaseURL = new URL(targetRaw);
  if (!targetBaseURL.protocol || !targetBaseURL.host) {
    throw new Error(`providers[${index}].targetBaseUrl must include scheme and host`);
  }

  const apiKey = readRequiredString(rawProvider.apiKey, `providers[${index}].apiKey`);

  return {
    name,
    virtualApiKeys: [...virtualApiKeys],
    targetBaseURL,
    apiKey
  };
}

function selectProvider(config: Config, request: IncomingMessage): ProviderSelectionResult {
  const credentials = collectRequestCredentials(request);
  for (const credential of credentials) {
    for (const provider of config.providers) {
      if (provider.virtualApiKeys.includes(credential.value)) {
        return {
          selection: {
            provider,
            matchedCredential: credential,
            virtualApiKey: credential.value
          },
          statusCode: 200,
          message: "ok"
        };
      }
    }
  }

  if (credentials.length > 0) {
    return { selection: null, statusCode: 403, message: "unknown virtual api-key" };
  }
  return { selection: null, statusCode: 401, message: "missing virtual api-key" };
}

function collectRequestCredentials(request: IncomingMessage): RequestCredential[] {
  const credentials: RequestCredential[] = [];
  const authorization = readFirstHeaderValue(request.headers.authorization);
  if (authorization) {
    const bearerValue = normalizeCredentialValue(authorization, "bearer");
    if (bearerValue) {
      credentials.push({
        value: bearerValue,
        rawValue: authorization,
        type: "authorization",
        scheme: "bearer",
        label: "authorization:bearer"
      });
    } else {
      const rawValue = normalizeCredentialValue(authorization, "raw");
      if (rawValue) {
        credentials.push({
          value: rawValue,
          rawValue: authorization,
          type: "authorization",
          scheme: "raw",
          label: "authorization:raw"
        });
      }
    }
  }

  for (const headerName of ["x-api-key", "api-key"]) {
    const headerValue = readFirstHeaderValue(request.headers[headerName]);
    if (!headerValue) {
      continue;
    }
    credentials.push({
      value: normalizeCredentialValue(headerValue, "raw"),
      rawValue: headerValue,
      type: "header",
      name: headerName,
      scheme: "raw",
      label: `header:${headerName}:raw`
    });
  }

  const requestUrl = new URL(request.url ?? "/", "http://proxy.local");
  const queryValue = requestUrl.searchParams.get("api_key") || "";
  if (queryValue) {
    credentials.push({
      value: normalizeCredentialValue(queryValue, "raw"),
      rawValue: queryValue,
      type: "query",
      name: "api_key",
      scheme: "raw",
      label: "query:api_key:raw"
    });
  }

  return credentials.filter((credential) => credential.value);
}

function normalizeCredentialValue(rawValue: string, scheme: CredentialScheme): string {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return "";
  }
  if (scheme === "raw") {
    return trimmed;
  }

  const bearerMatch = /^Bearer\s+(.+)$/i.exec(trimmed);
  return bearerMatch ? bearerMatch[1].trim() : "";
}

function buildUpstreamUrl(provider: ProviderConfig, incomingUrl: URL, selection: ProviderSelection, isWebSocket: boolean): URL {
  const upstreamUrl = new URL(provider.targetBaseURL.toString());
  upstreamUrl.pathname = joinPath(provider.targetBaseURL.pathname, incomingUrl.pathname);
  upstreamUrl.search = joinSearch(provider.targetBaseURL.search, incomingUrl.search);

  if (selection.matchedCredential.type === "query" && selection.matchedCredential.name) {
    upstreamUrl.searchParams.set(selection.matchedCredential.name, provider.apiKey);
  }

  if (isWebSocket) {
    if (upstreamUrl.protocol === "http:") {
      upstreamUrl.protocol = "ws:";
    } else if (upstreamUrl.protocol === "https:") {
      upstreamUrl.protocol = "wss:";
    }
  }

  return upstreamUrl;
}

function buildUpstreamHeaders(
  headers: IncomingHttpHeaders,
  selection: ProviderSelection,
  upstreamHost: string,
  isWebSocket: boolean
): Record<string, string | string[]> {
  const cloned = cloneHeaders(headers);

  if (isWebSocket) {
    for (const headerName of WEBSOCKET_HANDSHAKE_HEADERS) {
      delete cloned[headerName];
    }
  }

  cloned.host = upstreamHost;
  replaceKnownCredentialHeaders(cloned, selection.virtualApiKey, selection.provider.apiKey);

  return cloned;
}

function replaceKnownCredentialHeaders(
  headers: Record<string, string | string[]>,
  virtualApiKey: string,
  realApiKey: string
): void {
  const authorization = headers.authorization;
  if (authorization !== undefined) {
    headers.authorization = replaceHeaderValue(authorization, (value) => replaceAuthorizationCredential(value, virtualApiKey, realApiKey));
  }

  for (const headerName of ["x-api-key", "api-key"]) {
    const headerValue = headers[headerName];
    if (headerValue === undefined) {
      continue;
    }
    headers[headerName] = replaceHeaderValue(headerValue, (value) => (value.trim() === virtualApiKey ? realApiKey : value));
  }
}

function replaceHeaderValue(
  headerValue: string | string[],
  replacer: (value: string) => string
): string | string[] {
  if (Array.isArray(headerValue)) {
    return headerValue.map(replacer);
  }
  return replacer(headerValue);
}

function replaceAuthorizationCredential(value: string, virtualApiKey: string, realApiKey: string): string {
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (bearerMatch) {
    return bearerMatch[1].trim() === virtualApiKey ? `Bearer ${realApiKey}` : value;
  }
  return value.trim() === virtualApiKey ? realApiKey : value;
}

function writeErrorResponse(response: ServerResponse, statusCode: number, message: string): void {
  const payload = JSON.stringify({
    error: {
      message,
      type: errorTypeForStatus(statusCode),
      status: statusCode
    }
  });
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload).toString(),
    "x-proxy-by": "openclaw-proxy"
  });
  response.end(payload);
}

function writeUpgradeError(socket: Duplex, statusCode: number, message: string): void {
  const payload = JSON.stringify({
    error: {
      message,
      type: errorTypeForStatus(statusCode),
      status: statusCode
    }
  });
  const response = [
    `HTTP/1.1 ${statusCode} ${httpStatusText(statusCode)}`,
    "Connection: close",
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(payload)}`,
    "x-proxy-by: openclaw-proxy",
    "",
    payload
  ].join("\r\n");

  socket.write(response);
  socket.destroy();
}

function errorTypeForStatus(statusCode: number): string {
  if (statusCode === 400) {
    return "invalid_request_error";
  }
  if (statusCode === 401 || statusCode === 403) {
    return "authentication_error";
  }
  return "proxy_error";
}

function httpStatusText(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 502:
      return "Bad Gateway";
    default:
      return "Error";
  }
}

function parseWebSocketProtocols(headerValue: string | string[] | undefined): string[] {
  const rawValue = readFirstHeaderValue(headerValue);
  if (!rawValue) {
    return [];
  }
  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
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

function readFirstHeaderValue(headerValue: string | string[] | undefined): string {
  if (Array.isArray(headerValue)) {
    return headerValue.find((value) => value.trim()) || "";
  }
  return headerValue || "";
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

function readStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings`);
  }

  return value.map((entry, index) => readRequiredString(entry, `${fieldName}[${index}]`));
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
