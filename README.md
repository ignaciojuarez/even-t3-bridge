# even-t3-bridge

Unofficial [Even G2](https://evenrealities.com) Terminal Mode host for [T3 Code](https://github.com/pingdotgg/t3code). Not affiliated with Even or Ping. Not a Hub app.

The Even app only lists `claude` / `codex`. This host tags sessions **`codex`**. New threads use `model` / `provider` from config, else the T3 project default.

## Run

Node 22.16+, T3 running, bearer in `T3_TOKEN` or `~/.even-t3-bridge/t3_token` (T3 → Authorized clients → Create link). Stop stock `even-terminal` on `:3456`.

```sh
./start.sh              # LAN URL, binds 0.0.0.0
./start.sh --tailscale  # Tailscale URL + peer scan
./status.sh && ./stop.sh
```

Even App → Settings → **Terminal Mode** → Add Host. `new in <project> …` creates a local thread. `new in <host> <project> …` targets another T3. Tap-to-approve → `thread.approval.respond`.

## Config

Optional `~/.even-t3-bridge/config.json` ([example](./config.example.json)). Tokens live there, not in git.

| | |
|---|---|
| `defaultProject` | used when the prompt has no `new in …` |
| `runtimeMode` | T3 default, else `ask` |
| `model` / `provider` | T3 default for new threads |
| `environments[]` | extra hosts: `id`, `origin`, `token` or `tokenPath` |

`--tailscale` advertises this T3 on TCP `:3773` and scans peers. Pair a found host by writing its code to `~/.even-t3-bridge/t3_pair_<hostname>`.

The pairing URL is a bearer. Don’t commit or share it.

MIT. Even and Ping marks stay theirs.
