import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { loadUserFileConfig, parseArgs, resolveEnvironments, RUNTIME_DIR, loadT3Origin, type T3EnvSpec } from "./config.ts";
import { advertiseLocalT3, discoverTailscaleT3 } from "./discover.ts";
import { T3Provider } from "./provider.ts";
import { startHttpServer } from "./server.ts";
import { WIRE_PROVIDER } from "./types.ts";

function lanAddress(): string | undefined {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
}

function tailscaleAddress(): string | undefined {
  try {
    return (
      execSync("tailscale ip -4", { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 })
        .toString()
        .trim()
        .split("\n")[0]
        ?.trim() || undefined
    );
  } catch {
    return undefined;
  }
}

function advertiseHost(opts: { tailscale: boolean; host: string | null }): { label: string; address: string } {
  if (opts.host) return { label: "Host", address: opts.host };
  if (opts.tailscale) {
    const ip = tailscaleAddress();
    if (!ip) throw new Error("failed to get Tailscale IPv4 (is Tailscale.app connected?)");
    return { label: "Tailscale", address: ip };
  }
  return { label: "LAN", address: lanAddress() ?? "127.0.0.1" };
}

const seenPending = new Set<string>();

async function mergeDiscovered(envs: T3EnvSpec[]) {
  try {
    const { found, pending } = await discoverTailscaleT3({
      takenIds: new Set(envs.map((e) => e.id)),
      takenOrigins: new Set(envs.map((e) => e.origin)),
    });
    for (const spec of found) {
      envs.push(spec);
      console.warn(`[tailscale] T3 ${spec.id} ${spec.origin}`);
    }
    for (const row of pending) {
      if (seenPending.has(row)) continue;
      seenPending.add(row);
      console.warn(`[tailscale] ${row}`);
    }
    return found;
  } catch (err) {
    console.warn(`[tailscale] discover failed: ${(err as Error).message}`);
    return [];
  }
}

const file = loadUserFileConfig();
const config = parseArgs(process.argv.slice(2), file);
const origin = loadT3Origin();
config.environments = resolveEnvironments(file, origin, config.t3Token);
if (config.tailscale) {
  try {
    advertiseLocalT3();
  } catch (err) {
    console.warn(`[tailscale] advertise :3773 failed: ${(err as Error).message}`);
  }
  await mergeDiscovered(config.environments);
}
const advertise = advertiseHost({ tailscale: config.tailscale, host: config.host });
const provider = new T3Provider(config.environments, config);
provider.start();
if (config.tailscale) {
  setInterval(() => {
    void mergeDiscovered(config.environments).then((added) => {
      for (const spec of added) provider.addEnvironment(spec);
    });
  }, 60_000).unref();
}

const bindHost = config.host ?? "0.0.0.0";
const portExplicit = process.argv.includes("--port") || process.argv.includes("-p");
let server;
try {
  server = await startHttpServer(provider, { port: config.port, host: bindHost, token: config.token });
} catch (err) {
  const busy = (err as NodeJS.ErrnoException).code === "EADDRINUSE";
  if (busy && !portExplicit && config.port === 3456) {
    console.warn("Port 3456 in use (probably stock even-terminal). Trying 3457.");
    server = await startHttpServer(provider, { port: 3457, host: bindHost, token: config.token });
  } else if (busy) {
    console.error(`Port ${config.port} is in use. Stop stock even-terminal (or pass --port).`);
    process.exit(1);
  } else {
    throw err;
  }
}

mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
writeFileSync(
  join(RUNTIME_DIR, "runtime.json"),
  JSON.stringify({ pid: process.pid, port: server.port, origin, startedAt: new Date().toISOString() }, null, 2),
);

const url = `http://${advertise.address}:${server.port}?${new URLSearchParams({
  token: config.token,
  defaultProvider: WIRE_PROVIDER,
  name: config.name,
}).toString()}`;
process.stdout.write(`
  Even T3 Bridge  v0.1.0
  Name:       ${config.name}
  Local:      http://localhost:${server.port}
  ${advertise.label.padEnd(10)} http://${advertise.address}:${server.port}
  Token:      ${config.token.slice(0, 8)}...${config.token.slice(-4)}
  Provider:   ${WIRE_PROVIDER} (T3 threads underneath)
  T3 hosts:   ${config.environments.map((e) => e.id).join(", ")}

  Stop stock even-terminal if it is already bound to this port.
  Even App → Settings → Terminal Mode → Add Host (paste the URL)

  Full token: ${config.token}

  ${url}

`);

const shutdown = async () => {
  provider.stop();
  await server.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
