# even-t3-bridge

Unofficial [Even G2](https://evenrealities.com) **Terminal Mode** host that drives a local [T3 Code](https://github.com/pingdotgg/t3code) server.

Not an Even Hub app. Not affiliated with Even Realities or Ping. Independently implemented against the Terminal Mode HTTP + SSE contract so T3 threads can use the official glasses HUD (hold-to-talk, tap-to-approve).

The Even app only lists `claude` and `codex` sessions. This host defaults to **`codex`** on the wire (pairing URL + session list) so the Codex picker is not empty. New T3 threads use `model` / `provider` from config when set; otherwise the T3 project default. Follow-ups keep that thread’s existing model.

## Requirements

- Node 22.16+
- T3 Code running on this machine
- A T3 orchestration bearer in `T3_TOKEN` or `~/.even-t3-bridge/t3_token` (create one in T3 → Authorized clients → Create link, then redeem it against this machine, or copy a token you already issued)
- Even App → Settings → **Terminal Mode** → Add Host (not Hub Scan QR)
- Stock `even-terminal` **not** bound to `:3456`

## Run

```sh
./start.sh              # LAN pairing URL; binds all interfaces; Ctrl-C to stop
./start.sh --tailscale  # Tailscale pairing URL, advertise this T3, scan peers
./status.sh
./stop.sh
```

The process binds `0.0.0.0` unless you pass `--host`. Use `--host 127.0.0.1` to keep it local.

Paste the printed URL into Add Host. Follow-up voice turns call `thread.turn.start`. “new in \<exact T3 project title\> …” creates a thread on this machine’s T3. “new in studio My App …” targets another configured or discovered host. Tap-to-approve maps to `thread.approval.respond`.

```sh
npx tsx src/index.ts --port 3457 --token fixedtoken
```

## Config

Optional `~/.even-t3-bridge/config.json` (see [config.example.json](./config.example.json)). CLI > env > that file > safe defaults. Keep that directory out of git.

| Field / env | Default | Role |
|---|---|---|
| `defaultProject` / `EVEN_T3_DEFAULT_PROJECT` | first T3 project | used when the prompt has no “new in …” |
| `runtimeMode` / `EVEN_T3_RUNTIME_MODE` | T3 project default, else `ask` | `ask` or `full-access` |
| `model` + `provider` / `EVEN_T3_MODEL` + `EVEN_T3_PROVIDER` | T3 project default | T3 model for **new** threads (`cursor` + `composer-1.5`, `codex` + a Codex model, …) |
| `T3_TOKEN` | `~/.even-t3-bridge/t3_token` | local T3 orchestration bearer (never put this in JSON) |
| `EVEN_T3_BRIDGE_TOKEN` | generated `~/.even-t3-bridge/token` | glasses pairing token |
| `environments[]` | none | pin extra T3 hosts (`id`, `origin`, `token` or `tokenPath`) |
| `--tailscale` | off | print a Tailscale pairing URL, advertise this T3 on tailnet TCP `:3773`, scan peers |

Local threads keep their T3 UUID. Remote threads are listed as `<host>:<uuid>` with a `<host> ·` title prefix. One down host is skipped; the rest still list.

### Other T3 hosts on Tailscale

T3 listens on `127.0.0.1` until **Network access** is on; then `:3773` is reachable on the tailnet. `--tailscale` also runs `tailscale serve --tcp 3773` so localhost-only T3 is visible (existing HTTPS serve config is left alone).

A found peer still needs a pair. On that T3: **Authorized clients → Create link**. Put the code or `/pair#token=…` URL in `~/.even-t3-bridge/t3_pair_<hostname>` and restart. The bridge exchanges it for a bearer at `t3_token_<hostname>`. This does not decrypt T3 Connections or speak the T3 Connect relay.

## Security

- The glasses pairing URL is a bearer for this host. Do not commit it or paste it in public.
- `~/.even-t3-bridge/` holds tokens and pid. Mode `0700` / `0600`.
- Enabling T3 **Network access** or Tailscale TCP `:3773` exposes that T3 to the tailnet. Pairing is still required.
- Do not share pairing codes. They are one-time and short-lived.

## License

MIT for this repository’s source. Even Realities and Ping marks stay theirs.
