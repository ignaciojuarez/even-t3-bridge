import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_DIR, type T3EnvSpec } from "./config.ts";

const T3_PORT = 3773;
const PROBE_MS = 800;

interface TailscalePeer {
  Online?: boolean;
  OS?: string;
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
}

interface TailscaleStatus {
  Self?: TailscalePeer;
  Peer?: Record<string, TailscalePeer>;
}

export function envIdFromDns(dnsName: string): string {
  const label = (dnsName.replace(/\.$/, "").split(".")[0] ?? "peer")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z][\w-]*$/.test(label) ? label : `peer-${label.replace(/^[^a-z]+/, "") || "x"}`;
}

export function tokenForDiscovered(id: string): string | undefined {
  const env = process.env[`EVEN_T3_TOKEN_${id.toUpperCase().replace(/-/g, "_")}`]?.trim();
  if (env) return env;
  const path = join(RUNTIME_DIR, `t3_token_${id}`);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8").trim() || undefined;
}

export function pairingCredential(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    const fromQuery = url.searchParams.get("token")?.trim();
    if (fromQuery) return fromQuery;
    const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    const fromHash = new URLSearchParams(hash).get("token")?.trim();
    if (fromHash) return fromHash;
  } catch {
    /* raw code */
  }
  return trimmed.replace(/^token=/i, "").trim();
}

export function pairCodeFor(id: string): string | undefined {
  const env = process.env[`EVEN_T3_PAIR_${id.toUpperCase().replace(/-/g, "_")}`]?.trim();
  if (env) return pairingCredential(env);
  const path = join(RUNTIME_DIR, `t3_pair_${id}`);
  if (!existsSync(path)) return undefined;
  const value = pairingCredential(readFileSync(path, "utf8"));
  return value || undefined;
}

export async function redeemPairing(
  origin: string,
  credential: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(`${origin.replace(/\/$/, "")}/api/auth/browser-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  if (!res.ok) throw new Error(`pair HTTP ${res.status}`);
  const cookie = res.headers.get("set-cookie") ?? "";
  const match = cookie.match(/t3_session_\d+=([^;]+)/);
  if (!match?.[1]) throw new Error("pair response had no session cookie");
  return decodeURIComponent(match[1]);
}

function persistDiscoveredToken(id: string, token: string): void {
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(RUNTIME_DIR, `t3_token_${id}`), `${token}\n`, { mode: 0o600 });
  const pairPath = join(RUNTIME_DIR, `t3_pair_${id}`);
  if (existsSync(pairPath)) unlinkSync(pairPath);
}

export function parsePeerTargets(status: TailscaleStatus, skipIps: Set<string>): Array<{ id: string; origins: string[] }> {
  const rows: Array<{ id: string; origins: string[] }> = [];
  for (const peer of Object.values(status.Peer ?? {})) {
    if (!peer.Online) continue;
    const os = (peer.OS ?? "").toLowerCase();
    if (os === "ios" || os === "android") continue;
    const ipv4 = (peer.TailscaleIPs ?? []).find((ip) => ip.includes(".") && !skipIps.has(ip));
    if (!ipv4) continue;
    const dns = peer.DNSName?.replace(/\.$/, "") ?? "";
    const origins = [`http://${ipv4}:${T3_PORT}`];
    if (dns) origins.push(`https://${dns}`);
    rows.push({ id: envIdFromDns(dns || peer.HostName || ipv4), origins });
  }
  return rows;
}

export async function firstT3Origin(
  origins: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  for (const origin of origins) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_MS);
    try {
      const res = await fetchImpl(`${origin}/.well-known/t3/environment`, { signal: ctrl.signal });
      if (!res.ok) continue;
      const body = (await res.json()) as { environmentId?: string };
      if (body.environmentId) return origin.replace(/\/$/, "");
    } catch {
      /* peer has no T3 on this origin */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

export function advertiseLocalT3(): void {
  try {
    const raw = execSync("tailscale serve status --json", {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 4000,
    }).toString();
    const status = JSON.parse(raw) as { TCP?: Record<string, { TCPForward?: string }> };
    if (status.TCP?.[String(T3_PORT)]?.TCPForward) return;
  } catch {
    /* status missing is fine; still try to add */
  }
  execSync(`tailscale serve --bg --tcp ${T3_PORT} tcp://127.0.0.1:${T3_PORT}`, {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
}

export function loadTailscaleStatus(): TailscaleStatus {
  return JSON.parse(
    execSync("tailscale status --json", { stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }).toString(),
  ) as TailscaleStatus;
}

export async function discoverTailscaleT3(opts: {
  takenIds: Set<string>;
  takenOrigins: Set<string>;
  status?: TailscaleStatus;
  fetchImpl?: typeof fetch;
  tokenFor?: (id: string) => string | undefined;
}): Promise<{ found: T3EnvSpec[]; pending: string[] }> {
  const status = opts.status ?? loadTailscaleStatus();
  const skip = new Set(status.Self?.TailscaleIPs ?? []);
  const tokenFor = opts.tokenFor ?? tokenForDiscovered;
  const found: T3EnvSpec[] = [];
  const pending: string[] = [];
  for (const peer of parsePeerTargets(status, skip)) {
    if (opts.takenIds.has(peer.id)) continue;
    const origin = await firstT3Origin(peer.origins, opts.fetchImpl);
    if (!origin || opts.takenOrigins.has(origin)) continue;
    let token = tokenFor(peer.id);
    if (!token) {
      const code = pairCodeFor(peer.id);
      if (code) {
        try {
          token = await redeemPairing(origin, code, opts.fetchImpl);
          persistDiscoveredToken(peer.id, token);
        } catch (err) {
          pending.push(`${peer.id} ${origin} (pair failed: ${(err as Error).message})`);
          continue;
        }
      }
    }
    if (!token) {
      pending.push(
        `${peer.id} ${origin} — on that T3: Create pairing link, write the code to ~/.even-t3-bridge/t3_pair_${peer.id}`,
      );
      continue;
    }
    found.push({ id: peer.id, origin, token, defaultProject: "" });
  }
  return { found, pending };
}
