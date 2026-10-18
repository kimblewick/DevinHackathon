from __future__ import annotations

import json
import logging
import mimetypes
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .game import Game, GameError

logger = logging.getLogger("devinhackathon")

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

ROUTES = {"/": "index.html", "/host": "host.html", "/markers": "markers.html"}

MIME_OVERRIDES = {
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".css": "text/css",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
}


class GameServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, handler, game: Game):
        super().__init__(addr, handler)
        self.game = game
        self.tls_port = 0
        self.lan_ip = None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "devinhackathon/0.1"

    @property
    def game(self) -> Game:
        return self.server.game

    # ---------- helpers ----------

    def _send_json(self, obj, status: int = 200) -> None:
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_file(self, path: str) -> None:
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            self._send_json({"error": "not found"}, 404)
            return
        ext = os.path.splitext(path)[1].lower()
        ctype = MIME_OVERRIDES.get(ext) or mimetypes.guess_type(path)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        body = self.rfile.read(min(length, 1 << 20)) if length > 0 else b""
        try:
            return json.loads(body) if body else {}
        except json.JSONDecodeError:
            raise GameError("bad_json", "request body is not valid JSON")

    def _token(self) -> str | None:
        return self.headers.get("X-Player-Token")

    def log_message(self, fmt: str, *args) -> None:
        logger.debug("http " + fmt, *args)

    # ---------- GET ----------

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/health":
            self._send_json({"status": "ok", "phase": self.game.phase})
            return
        if path == "/api/state":
            qs = parse_qs(urlparse(self.path).query)
            token = self._token() or (qs.get("token") or [None])[0]
            out = self.game.state(token) | {"tls_port": self.server.tls_port, "lan_ip": self.server.lan_ip}
            if "map" in qs:
                out["map"] = self.game.map_data()
            self._send_json(out)
            return
        if path in ROUTES:
            self._send_file(os.path.join(STATIC_DIR, ROUTES[path]))
            return
        rel = os.path.normpath(path.lstrip("/"))
        full = os.path.realpath(os.path.join(STATIC_DIR, rel))
        if full.startswith(STATIC_DIR + os.sep) and os.path.isfile(full):
            self._send_file(full)
            return
        self._send_json({"error": "not found"}, 404)

    # ---------- POST ----------

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            body = self._read_json()
            if path == "/api/join":
                player = self.game.join(
                    body.get("name", ""), body.get("marker_id", -1), body.get("token")
                )
                self._send_json({"ok": True, "player": player})
            elif path == "/api/hit":
                self._send_json(
                    {
                        "ok": True,
                        **self.game.hit(
                            body.get("player_id"), self._token(), body.get("marker_id")
                        ),
                    }
                )
            elif path == "/api/telemetry":
                self.game.telemetry(
                    body.get("player_id"), self._token(),
                    body.get("heading"), body.get("steps"), body.get("sightings"),
                )
                self._send_json({"ok": True})
            elif path == "/api/admin":
                self._admin(body)
            else:
                self._send_json({"error": "not found"}, 404)
        except GameError as e:
            self._send_json({"ok": False, "error": e.code, "message": e.message}, 400)
        except (TypeError, ValueError) as e:
            self._send_json({"ok": False, "error": "bad_request", "message": str(e)}, 400)

    def _admin(self, body: dict) -> None:
        action = body.get("action")
        if action == "start":
            self.game.start()
        elif action == "reset":
            self.game.reset()
        elif action == "wipe":
            self.game.wipe()
        elif action == "config":
            self.game.configure(body.get("hits_to_eliminate"), body.get("cooldown_s"))
        else:
            raise GameError("bad_action", "action must be start|reset|wipe|config")
        self._send_json({"ok": True})


def make_server(port: int, game: Game, host: str = "0.0.0.0") -> GameServer:
    return GameServer((host, port), Handler, game)
