# DevinHackathon — AR Paintball

A web-based AR paintball game hosted entirely on the Raspberry Pi. Each player
gets a numbered ArUco marker (#1–#20) to wear, joins from their phone by typing
their name and number, and "shoots" opponents by pointing their camera at the
other player's marker. The marker's decoded id *is* the player number.

- **Detection is client-side** — marker scanning happens in the browser
  (vendored js-aruco); the Pi only receives "player X detected marker Y".
- **Two camera modes**, picked automatically:
  - **Live AR** (recommended) — continuous video + crosshair + auto-fire.
    iPhones only allow live camera on HTTPS, so the app also serves a
    self-signed HTTPS listener on `TLS_PORT` (default **3443**). Players open
    `https://pi-06.local:3443`, tap **Show Details → visit this website** on
    Safari's certificate warning once, then allow the camera.
  - **Photo mode** — what you get on plain HTTP: tap SHOOT → native camera →
    snap → hit registers. The HTTP page shows an **ENABLE LIVE CAMERA** button
    that links to the HTTPS URL.

## Pages

| URL        | What                                                        |
|------------|-------------------------------------------------------------|
| `/`        | player app — join, scan marker, lobby, shoot, results       |
| `/host`    | host dashboard — start/reset, config, live scoreboard       |
| `/markers` | printable sheet of fixed markers #1–#20 (files at `/markers/N.svg`) |
| `/health`  | `{"status":"ok"}`                                           |

## Game rules (defaults, configurable on /host)

- Join during **lobby** only: name + your marker number (1–20). Each number
  can be claimed once per round.
- One hit = **out** (`hits_to_eliminate`, default 1).
- 2s shot cooldown (`cooldown_s`) — every shot starts a reload, even a miss.
- Last player standing wins; host resets to lobby for the next round.

## API

```
GET  /api/state?token=        phase, players, alive, winner, events, you
POST /api/join   {name, marker_id, token?}
POST /api/hit    {player_id, marker_id}      + X-Player-Token header
POST /api/admin  {action: start|reset|config, hits_to_eliminate?, cooldown_s?}   (no auth — LAN only)
```

## Running

`./start.sh` is the entry point (required by the Pi host): listens on `$PORT`
(default 3000), uses `.venv/bin/python` if present, else `python3`. Runtime
deps are in `requirements.txt` (only `gpiozero`, optional at runtime).

```sh
make setup && make run      # dev: http://localhost:3000 (live AR works — localhost is a secure context)
./start.sh                  # exactly what the Pi runs
make test && make lint
```

## Deploy to pi-06

```sh
make deploy                 # rsync → hacker6@pi-06.local:~/app, then restart
```

`deploy.sh` prefers the organisers' `deploy` / `app-restart` helpers and falls
back to `scripts/install.sh` (a systemd unit that runs `start.sh`).

Player instructions: grab a marker from the printed sheet → join the event
Wi-Fi → open `https://pi-06.local:3443` (the /host page shows this) → accept
the cert warning → enter name + the number on your marker.

## Layout

```
src/devinhackathon/game.py    game state: players, hits, cooldown, win
src/devinhackathon/server.py  HTTP server: static files + JSON API (+optional TLS)
src/devinhackathon/main.py    entry point: HTTP on $PORT, optional TLS, LED on events
src/devinhackathon/static/    player app, host page, marker sheet, vendored js-aruco
start.sh                      Pi host entry point (.venv/bin/python or python3)
app.py                        alt entry point: python3 app.py
tests/test_game.py            game rules + HTTP smoke test
```
