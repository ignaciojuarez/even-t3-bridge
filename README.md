# even-t3-bridge

[![test](https://github.com/ignaciojuarez/even-t3-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/ignaciojuarez/even-t3-bridge/actions/workflows/test.yml)

Use [T3 Code](https://github.com/pingdotgg/t3code) from the Terminal Mode UI on
[Even G2](https://www.evenrealities.com) glasses: start and continue threads,
stream replies, answer questions, approve tools, and interrupt runs.

Unofficial and not affiliated with Even Realities or Ping. This is a Terminal
Mode host, not an Even Hub app.

## Requirements

- macOS with T3 Code running
- Even G2 glasses and the Even app
- Node.js 22.16 or newer
- Tailscale only if you want to reach T3 hosts on other Macs

## Quick start

```sh
git clone https://github.com/ignaciojuarez/even-t3-bridge.git
cd even-t3-bridge
mkdir -p ~/.even-t3-bridge && chmod 700 ~/.even-t3-bridge
```

In T3 Code, open **Settings → Connections**, create a pairing link, and copy
it. Save the copied link without putting it in your shell history:

```sh
pbpaste > ~/.even-t3-bridge/t3_pair_local
chmod 600 ~/.even-t3-bridge/t3_pair_local
./start.sh
```

The bridge exchanges that one-time credential, stores the resulting session in
`~/.even-t3-bridge/t3_token`, deletes the pairing file, and prints its Terminal
Mode URL. In the Even app, open **Settings → Terminal Mode → Add Host** and
paste that URL.

If you already have a T3 bearer, set `T3_TOKEN` or save it as
`~/.even-t3-bridge/t3_token` instead. `start.sh` installs dependencies on its
first run.

## Use

- Speak normally to continue the selected thread.
- Say `new in My App fix the login` to create a thread in a T3 project.
- Say `new in studio My App run the tests` to target a configured remote host.
- Use the glasses UI to approve or deny tools, answer questions, or interrupt.

The Even app only identifies Terminal Mode sessions as `claude` or `codex`, so
the bridge labels them `codex`. The actual provider and model come from the T3
project default unless overridden in bridge config.

## Configuration

Configuration is optional. Copy [`config.example.json`](./config.example.json)
to `~/.even-t3-bridge/config.json` and edit it there.

| Key | Purpose |
|---|---|
| `defaultProject` | Project used when a new prompt does not name one |
| `runtimeMode` | T3 runtime mode; defaults to `ask` |
| `provider` / `model` | Provider instance and model for new threads |
| `options` | Model option IDs and values passed to T3 |
| `environments[]` | Extra T3 hosts with `id`, `origin`, `token` or `tokenPath`, and optional `defaultProject` |

Useful environment variables are `T3_TOKEN`, `EVEN_T3_MODEL`,
`EVEN_T3_PROVIDER`, `EVEN_T3_DEFAULT_PROJECT`, `EVEN_T3_RUNTIME_MODE`,
`EVEN_T3_BRIDGE_TOKEN`, `EVEN_TERMINAL_NAME`, and `PORT`. Run
`./start.sh --help` for command-line options.

### Tailscale and multiple Macs

```sh
./start.sh --tailscale
```

This advertises the local T3 server on tailnet TCP port `3773` and scans online
desktop peers for T3. For each discovered host, create a pairing link on that
Mac and save it locally as `~/.even-t3-bridge/t3_pair_<hostname>`. The bridge
redeems it on the next scan. You can also define already-reachable hosts in
`environments[]`.

## Security

The printed Terminal Mode URL contains a bearer token that can operate your T3
threads, including approvals. Treat it like a password. Do not post it, commit
it, paste it into bug reports, or use the bridge on an untrusted network. The
default server listens on all interfaces so your phone can connect; requests
under `/api/` require the bearer.

Credentials and runtime state stay under `~/.even-t3-bridge/` and are ignored
by git. Pairing links are one-time credentials and are deleted after a
successful exchange.

## Troubleshooting

- `T3 is not running`: start T3 Code before the bridge.
- `T3 bearer missing`: repeat the pairing step above.
- Port `3456` is busy: stop the stock `even-terminal`; the bridge automatically
  tries `3457` unless you chose a port explicitly.
- `No model`: set a default model on the T3 project or configure `provider` and
  `model`.
- `T3 project not found`: set `defaultProject` to the title shown in T3 or name
  the project in your prompt.

`./status.sh` shows bridge and T3 state; `./stop.sh` stops the bridge.

## Development

```sh
npm ci
npm run check
```

The bridge is intentionally small: a dependency-light HTTP/SSE adapter over
T3's orchestration API. That API can change while T3 Code is under active
development.

MIT licensed. Even Realities and Ping trademarks belong to their owners.
