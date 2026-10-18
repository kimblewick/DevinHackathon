from __future__ import annotations

import logging
import math
import secrets
import threading
import time

logger = logging.getLogger("devinhackathon")


class GameError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


MARKER_MIN, MARKER_MAX = 1, 20
STEP_M = 0.7          # metres per detected step (dead reckoning)
TRAIL_LEN = 80
SIGHT_TTL = 3.0       # seconds a camera sighting stays "fresh"
MOVING_TTL = 2.5
INK = [
    "#ff6a00", "#00e0ff", "#c6ff00", "#ff2aa8", "#8a3cff",
    "#00ff88", "#ffd500", "#ff3b3b", "#00b3ff", "#ff8ad8",
]


class Game:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.players = {}
        self.phase = "lobby"  # lobby | running | ended
        self.hits_to_eliminate = 3
        self.cooldown_s = 0.3
        self.winner_id = None
        self.events = []
        self._last_shot = {}
        self._next_id = 1
        self.on_event = None  # optional callback(str)

    def _emit(self, msg: str) -> None:
        self.events.append({"ts": time.time(), "msg": msg})
        del self.events[:-50]
        if self.on_event is not None:
            try:
                self.on_event(msg)
            except Exception:
                logger.debug("on_event callback failed", exc_info=True)

    @staticmethod
    def _public_color(p: dict) -> str:
        return INK[(p["marker_id"] - 1) % len(INK)]

    @staticmethod
    def _public(p: dict) -> dict:
        return {
            "id": p["id"],
            "name": p["name"],
            "marker_id": p["marker_id"],
            "color": INK[(p["marker_id"] - 1) % len(INK)],
            "alive": p["alive"],
            "kills": p["kills"],
            "hits_taken": p["hits_taken"],
            "paint": p["paint"],
        }

    def _by_token(self, token: str | None) -> dict | None:
        if not token:
            return None
        for p in self.players.values():
            if p["token"] == token:
                return p
        return None

    def _marker_owner(self, marker_id: int) -> dict | None:
        for p in self.players.values():
            if p["marker_id"] == marker_id:
                return p
        return None

    def join(self, name: str, marker_id: int, token: str | None = None) -> dict:
        name = (name or "").strip()[:24]
        marker_id = int(marker_id)
        if not name:
            raise GameError("bad_name", "name required")
        if not MARKER_MIN <= marker_id <= MARKER_MAX:
            raise GameError("bad_marker", f"number must be {MARKER_MIN}–{MARKER_MAX}")
        with self.lock:
            player = self._by_token(token)
            if player is not None:
                owner = self._marker_owner(marker_id)
                if owner is not None and owner["id"] != player["id"]:
                    raise GameError("marker_taken", "that marker is already claimed")
                player["name"] = name
                player["marker_id"] = marker_id
                return self._public(player) | {"token": player["token"]}
            if self._marker_owner(marker_id) is not None:
                raise GameError("marker_taken", "that marker is already claimed")
            pid = self._next_id
            self._next_id += 1
            player = {
                "id": pid,
                "token": secrets.token_hex(8),
                "name": name,
                "marker_id": marker_id,
                "alive": True,
                "kills": 0,
                "hits_dealt": 0,
                "hits_taken": 0,
                "paint": [],
                # live-map telemetry (approximate, relative positions)
                "pos": self._spawn_pos(pid),
                "heading": 0.0,
                "steps": None,
                "trail": [],
                "last_move": 0.0,
                "tele_t": 0.0,
                "seen": {},
            }
            self.players[pid] = player
            self._emit(f"{name} joined (marker {marker_id})" + (" mid-game" if self.phase == "running" else ""))
            return self._public(player) | {"token": player["token"]}

    @staticmethod
    def _spawn_pos(pid: int) -> list[float]:
        a = math.radians(pid * 137.5)   # golden-angle spread around a 2.5 m ring
        return [2.5 * math.sin(a), -2.5 * math.cos(a)]

    def _push_trail(self, p: dict) -> None:
        pt = [round(p["pos"][0], 2), round(p["pos"][1], 2)]
        if not p["trail"] or math.dist(p["trail"][-1], pt) >= 0.25:
            p["trail"].append(pt)
            del p["trail"][:-TRAIL_LEN]

    def telemetry(
        self,
        player_id: int,
        token: str | None,
        heading: float | None = None,
        steps: int | None = None,
        sightings: list[dict] | None = None,
    ) -> None:
        with self.lock:
            p = self.players.get(int(player_id))
            if p is None or p["token"] != token:
                raise GameError("unauthorized", "bad player token")
            now = time.time()
            p["tele_t"] = now
            if heading is not None:
                p["heading"] = float(heading) % 360.0
            if steps is not None:
                steps = int(steps)
                delta = 0 if p["steps"] is None else steps - p["steps"]
                p["steps"] = steps
                if 0 < delta < 20:
                    h = math.radians(p["heading"])
                    p["pos"][0] += math.sin(h) * STEP_M * delta
                    p["pos"][1] -= math.cos(h) * STEP_M * delta
                    p["last_move"] = now
                    self._push_trail(p)
            for s in sightings or []:
                other = self._marker_owner(int(s.get("marker_id", -1)))
                if other is None or other is p:
                    continue
                dist = min(8.0, max(0.5, float(s.get("dist", 2.0))))
                p["seen"][other["id"]] = {"dist": dist, "t": now}
                self._nudge(p, other, dist)

    def _nudge(self, viewer: dict, seen: dict, dist: float) -> None:
        """Pull the seen player toward where the viewer's camera says they are."""
        h = math.radians(viewer["heading"])
        tx = viewer["pos"][0] + math.sin(h) * dist
        ty = viewer["pos"][1] - math.cos(h) * dist
        dx, dy = tx - seen["pos"][0], ty - seen["pos"][1]
        seen["pos"][0] += dx * 0.35
        seen["pos"][1] += dy * 0.35
        viewer["pos"][0] -= dx * 0.1
        viewer["pos"][1] -= dy * 0.1
        self._push_trail(seen)

    def map_data(self) -> dict:
        now = time.time()
        with self.lock:
            out = {}
            for p in self.players.values():
                out[p["id"]] = {
                    "pos": [round(p["pos"][0], 2), round(p["pos"][1], 2)],
                    "heading": round(p["heading"], 1),
                    "trail": p["trail"],
                    "moving": now - p["last_move"] < MOVING_TTL,
                    "online": now - p["tele_t"] < 6.0,
                    "seen": [
                        {"id": oid, "dist": round(v["dist"], 1), "age": round(now - v["t"], 1)}
                        for oid, v in p["seen"].items()
                        if now - v["t"] < SIGHT_TTL and oid in self.players
                    ],
                }
            return out

    def hit(self, player_id: int, token: str | None, marker_id: int) -> dict:
        with self.lock:
            shooter = self.players.get(int(player_id))
            if shooter is None or shooter["token"] != token:
                raise GameError("unauthorized", "bad player token")
            if self.phase != "running":
                raise GameError("not_running", "game is not running")
            if not shooter["alive"]:
                raise GameError("dead", "you are out")
            now = time.time()
            last = self._last_shot.get(shooter["id"], 0.0)
            if now - last < self.cooldown_s:
                wait = round(self.cooldown_s - (now - last), 1)
                raise GameError("cooldown", f"reloading — {wait}s")
            self._last_shot[shooter["id"]] = now

            victim = self._marker_owner(int(marker_id))
            if victim is None:
                return {"result": "unknown_marker", "victim": None}
            if victim["id"] == shooter["id"]:
                return {"result": "own_marker", "victim": None}
            if not victim["alive"]:
                return {"result": "already_out", "victim": self._public(victim)}

            victim["hits_taken"] += 1
            victim["paint"].append(self._public_color(shooter))
            shooter["hits_dealt"] += 1
            result = "hit"
            if victim["hits_taken"] >= self.hits_to_eliminate:
                victim["alive"] = False
                shooter["kills"] += 1
                result = "eliminated"
                self._emit(f"{shooter['name']} SPLATTED {victim['name']}!")
            else:
                self._emit(
                    f"{shooter['name']} inked {victim['name']} "
                    f"({victim['hits_taken']}/{self.hits_to_eliminate})"
                )
            self._check_end()
            return {"result": result, "victim": self._public(victim)}

    def _alive(self) -> list[dict]:
        return [p for p in self.players.values() if p["alive"]]

    def _check_end(self) -> None:
        alive = self._alive()
        if self.phase == "running" and len(alive) <= 1:
            self.phase = "ended"
            self.winner_id = alive[0]["id"] if alive else None
            if self.winner_id is not None:
                self._emit(f"winner: {alive[0]['name']}")

    def start(self) -> None:
        with self.lock:
            if self.phase != "lobby":
                raise GameError("bad_phase", "reset to lobby first")
            for p in self.players.values():
                p["alive"] = True
                p["kills"] = 0
                p["hits_dealt"] = 0
                p["hits_taken"] = 0
                p["paint"] = []
            self._last_shot.clear()
            self.winner_id = None
            self.phase = "running"
            self._emit("game started")

    def reset(self) -> None:
        with self.lock:
            self.phase = "lobby"
            self.winner_id = None
            self._last_shot.clear()
            self._emit("game reset — back to lobby")

    def wipe(self) -> None:
        """Kick everyone: drop all players and go back to an empty lobby."""
        with self.lock:
            self.players.clear()
            self._last_shot.clear()
            self.winner_id = None
            self.phase = "lobby"
            self.events.clear()
            self._emit("host restarted the match — everyone was kicked")

    def configure(
        self,
        hits_to_eliminate: int | None = None,
        cooldown_s: float | None = None,
    ) -> None:
        with self.lock:
            if hits_to_eliminate is not None:
                self.hits_to_eliminate = max(1, int(hits_to_eliminate))
            if cooldown_s is not None:
                self.cooldown_s = max(0.0, float(cooldown_s))

    def state(self, token: str | None = None) -> dict:
        with self.lock:
            you = self._by_token(token)
            winner = self.players.get(self.winner_id) if self.winner_id else None
            return {
                "phase": self.phase,
                "alive": len(self._alive()),
                "players": [self._public(p) for p in self.players.values()],
                "winner": self._public(winner) if winner else None,
                "config": {
                    "hits_to_eliminate": self.hits_to_eliminate,
                    "cooldown_s": self.cooldown_s,
                },
                "events": self.events[-15:],
                "you": self._public(you) if you else None,
            }
