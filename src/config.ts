import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { T3ModelSelection } from "./types.ts";

export const RUNTIME_DIR = join(homedir(), ".even-t3-bridge");
export const T3_RUNTIME_PATH = join(homedir(), ".t3", "userdata", "server-runtime.json");
export const USER_CONFIG_PATH = join(RUNTIME_DIR, "config.json");

export interface EnvFileConfig {
  id: string;
  origin: string;
  token?: string;
  tokenPath?: string;
  defaultProject?: string;
}

export interface UserFileConfig {
  defaultProject?: string;
  runtimeMode?: string;
  provider?: string;
  model?: string;
  options?: Array<{ id: string; value: string | boolean }>;
  environments?: EnvFileConfig[];
}

export interface T3EnvSpec {
  id: string;
  origin: string;
  token: string;
  defaultProject: string;
}

export interface BridgeConfig {
  defaultProject: string;
  runtimeMode: string;
  interactionMode: string;
  pollMs: number;
  model: T3ModelSelection | null;
  port: number;
  token: string;
  tailscale: boolean;
  host: string | null;
  name: string;
  t3Token: string;
  environments: T3EnvSpec[];
}

export const DEFAULTS = {
  defaultProject: "",
  runtimeMode: "ask",
  interactionMode: "default",
  pollMs: 1500,
  model: null as T3ModelSelection | null,
  environments: [] as T3EnvSpec[],
};

export function loadUserFileConfig(path = USER_CONFIG_PATH): UserFileConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as UserFileConfig;
  } catch {
    throw new Error(`Invalid JSON in ${path}`);
  }
}

function modelFrom(file: UserFileConfig): T3ModelSelection | null {
  const model = process.env.EVEN_T3_MODEL?.trim() || file.model?.trim();
  if (!model) return null;
  const instanceId = process.env.EVEN_T3_PROVIDER?.trim() || file.provider?.trim() || "cursor";
  return file.options?.length ? { instanceId, model, options: file.options } : { instanceId, model };
}

export function persistBridgeToken(token: string): void {
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(RUNTIME_DIR, "token"), `${token}\n`, { mode: 0o600 });
}

export function loadOrCreateBridgeToken(explicit?: string): string {
  if (explicit) {
    persistBridgeToken(explicit);
    return explicit;
  }
  const fromEnv = process.env.EVEN_T3_BRIDGE_TOKEN?.trim();
  if (fromEnv) {
    persistBridgeToken(fromEnv);
    return fromEnv;
  }
  const stored = join(RUNTIME_DIR, "token");
  if (existsSync(stored)) {
    const value = readFileSync(stored, "utf8").trim();
    if (value) return value;
  }
  const generated = randomBytes(16).toString("hex");
  persistBridgeToken(generated);
  return generated;
}

export function loadT3Token(): string {
  const fromEnv = process.env.T3_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const stored = join(RUNTIME_DIR, "t3_token");
  if (existsSync(stored)) {
    const value = readFileSync(stored, "utf8").trim();
    if (value) return value;
  }
  throw new Error(
    `T3 bearer missing. Set T3_TOKEN or write the owner token to ${stored}`,
  );
}

function expandHome(path: string): string {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

function readTokenFile(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`T3 bearer missing at ${path}`);
  }
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error(`T3 bearer empty at ${path}`);
  return value;
}

export function resolveEnvironments(
  file: UserFileConfig,
  localOrigin: string,
  localToken: string,
): T3EnvSpec[] {
  const local: T3EnvSpec = {
    id: "local",
    origin: localOrigin.replace(/\/$/, ""),
    token: localToken,
    defaultProject: process.env.EVEN_T3_DEFAULT_PROJECT?.trim() || file.defaultProject?.trim() || "",
  };
  const extra = (file.environments ?? []).map((row) => {
    const id = row.id?.trim();
    if (!id || id === "local") throw new Error("environment id is required and cannot be 'local'");
    if (!/^[a-zA-Z][\w-]*$/.test(id)) {
      throw new Error(`environment id "${id}" must be letters/digits/hyphens`);
    }
    const origin = row.origin?.trim().replace(/\/$/, "");
    if (!origin) throw new Error(`environment "${id}" needs origin`);
    const token =
      row.token?.trim() ||
      (row.tokenPath ? readTokenFile(expandHome(row.tokenPath)) : "") ||
      process.env[`EVEN_T3_TOKEN_${id.toUpperCase().replace(/-/g, "_")}`]?.trim();
    if (!token) {
      throw new Error(
        `environment "${id}" needs token, tokenPath, or EVEN_T3_TOKEN_${id.toUpperCase().replace(/-/g, "_")}`,
      );
    }
    return {
      id,
      origin,
      token,
      defaultProject: row.defaultProject?.trim() || "",
    };
  });
  return [local, ...extra];
}

export function loadT3Origin(): string {
  if (!existsSync(T3_RUNTIME_PATH)) {
    throw new Error(`T3 is not running (missing ${T3_RUNTIME_PATH})`);
  }
  const data = JSON.parse(readFileSync(T3_RUNTIME_PATH, "utf8")) as {
    origin?: string;
  };
  if (!data.origin) throw new Error("T3 server-runtime.json has no origin");
  return data.origin.replace(/\/$/, "");
}

export function parseArgs(argv: string[], file = loadUserFileConfig()): BridgeConfig {
  let port = Number(process.env.PORT ?? 3456);
  let token: string | undefined;
  let tailscale = false;
  let host: string | null = null;
  let name = process.env.EVEN_TERMINAL_NAME ?? "t3-bridge";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--port" || arg === "-p") port = Number(argv[++i]);
    else if (arg === "--token" || arg === "-t") token = argv[++i];
    else if (arg === "--tailscale") tailscale = true;
    else if (arg === "--host") host = argv[++i] ?? null;
    else if (arg === "--name" || arg === "-n") name = argv[++i] ?? name;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return {
    defaultProject: process.env.EVEN_T3_DEFAULT_PROJECT?.trim() || file.defaultProject?.trim() || "",
    runtimeMode: process.env.EVEN_T3_RUNTIME_MODE?.trim() || file.runtimeMode?.trim() || "",
    interactionMode: DEFAULTS.interactionMode,
    pollMs: DEFAULTS.pollMs,
    model: modelFrom(file),
    port: Number.isFinite(port) && port > 0 ? port : 3456,
    token: loadOrCreateBridgeToken(token),
    tailscale,
    host,
    name,
    t3Token: loadT3Token(),
    environments: [],
  };
}

function printHelp(): void {
  process.stdout.write(`even-t3-bridge — T3 Code on Even G2 Terminal Mode

  --port, -p       listen port (default 3456)
  --token, -t      fixed pairing token (also stored in ~/.even-t3-bridge/token)
  --tailscale      Tailscale pairing URL, advertise this T3 on TCP :3773, scan the tailnet
  --host           bind/advertise this address instead (default bind is 0.0.0.0)
  --name, -n       name shown in the Even app

Optional ~/.even-t3-bridge/config.json — see config.example.json
Tailscale peers that answer /.well-known/t3/environment are picked up automatically.
Bearer for a peer: ~/.even-t3-bridge/t3_token_<hostname> (or environments[]).
Stop stock even-terminal first if it is already on :3456.
`);
}
