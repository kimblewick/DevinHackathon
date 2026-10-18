import json
import threading
import urllib.request

import pytest

from devinhackathon.game import Game, GameError
from devinhackathon.server import make_server


def join2():
    g = Game()
    g.configure(hits_to_eliminate=1, cooldown_s=2.0)
    a = g.join("alice", 10)
    b = g.join("bob", 20)
    return g, a, b


def test_join_assigns_marker_and_token():
    _, a, _ = join2()
    assert a["name"] == "alice" and a["marker_id"] == 10
    assert len(a["token"]) == 16


def test_defaults_and_ink_color():
    g = Game()
    a = g.join("alice", 1)
    b = g.join("bob", 11)
    assert g.hits_to_eliminate == 3 and g.cooldown_s == 0.3
    assert a["color"] == b["color"] == "#ff6a00"  # palette wraps every 10
    assert g.join("carol", 2)["color"] == "#00e0ff"


def test_paint_records_attacker_colors_and_resets():
    g = Game()
    g.configure(hits_to_eliminate=3, cooldown_s=0)
    a = g.join("alice", 1)   # orange
    b = g.join("bob", 2)     # cyan
    g.start()
    g.hit(a["id"], a["token"], 2)
    g.hit(a["id"], a["token"], 2)
    bob = g.state()["players"][1]
    assert bob["hits_taken"] == 2 and bob["paint"] == ["#ff6a00", "#ff6a00"]
    assert bob["alive"]
    g.hit(a["id"], a["token"], 2)
    assert not g.state()["players"][1]["alive"]
    g.reset()
    g.start()
    assert g.state()["players"][1]["paint"] == [] and b["marker_id"] == 2


def test_marker_cannot_be_claimed_twice():
    g, _, _ = join2()
    with pytest.raises(GameError, match="claimed"):
        g.join("carol", 10)


@pytest.mark.parametrize("bad", [0, 21, -1])
def test_marker_number_out_of_range(bad):
    with pytest.raises(GameError, match="1–20"):
        Game().join("zed", bad)


def test_late_join_while_running_is_allowed():
    g, _a, _ = join2()
    g.start()
    c = g.join("carol", 15)
    assert g.players[c["id"]]["alive"] and g.phase == "running"
    assert "mid-game" in g.events[-1]["msg"]


def test_hit_eliminates_and_ends_game():
    g, a, b = join2()
    g.start()
    res = g.hit(a["id"], a["token"], 20)
    assert res["result"] == "eliminated"
    assert g.phase == "ended"
    assert g.winner_id == a["id"]
    assert not g.players[b["id"]]["alive"]


def test_hit_requires_multiple_with_config():
    g, a, b = join2()
    g.configure(hits_to_eliminate=2, cooldown_s=0)
    g.start()
    assert g.hit(a["id"], a["token"], 20)["result"] == "hit"
    assert g.players[b["id"]]["alive"]
    assert g.hit(a["id"], a["token"], 20)["result"] == "eliminated"


def test_cooldown_blocks_rapid_fire():
    g, a, _ = join2()
    g.start()
    g.hit(a["id"], a["token"], 20)
    g.phase = "running"  # reopen after elimination for the cooldown check
    with pytest.raises(GameError, match="reloading"):
        g.hit(a["id"], a["token"], 20)


def test_own_and_unknown_markers():
    g, a, _ = join2()
    g.configure(cooldown_s=0)
    g.start()
    assert g.hit(a["id"], a["token"], 10)["result"] == "own_marker"
    assert g.hit(a["id"], a["token"], 999)["result"] == "unknown_marker"


def test_bad_token_rejected():
    g, a, _ = join2()
    g.start()
    with pytest.raises(GameError, match="token"):
        g.hit(a["id"], "wrong", 20)


def test_dead_player_cannot_shoot():
    g, a, b = join2()
    g.configure(cooldown_s=0)
    g.start()
    g.hit(a["id"], a["token"], 20)
    g.phase = "running"  # pretend the round continues
    with pytest.raises(GameError, match="out"):
        g.hit(b["id"], b["token"], 10)


def test_wipe_kicks_everyone_and_invalidates_tokens():
    g, a, _ = join2()
    g.start()
    g.wipe()
    assert g.phase == "lobby" and g.players == {}
    assert g.state(a["token"])["you"] is None
    assert g.join("alice", 10)["marker_id"] == 10  # marker is free again


def test_telemetry_dead_reckoning_and_sighting_nudge():
    g = Game()
    a = g.join("alice", 1)
    b = g.join("bob", 2)
    pa, pb = g.players[a["id"]], g.players[b["id"]]
    pa["pos"], pb["pos"] = [0.0, 0.0], [5.0, 5.0]
    # first steps report is a baseline, no movement
    g.telemetry(a["id"], a["token"], heading=90, steps=10)
    assert pa["pos"] == [0.0, 0.0]
    # 2 steps facing east (90°) -> +1.4 m in x
    g.telemetry(a["id"], a["token"], heading=90, steps=12)
    assert round(pa["pos"][0], 2) == 1.4 and abs(pa["pos"][1]) < 1e-9
    # alice sees bob 2 m straight ahead (east): bob gets pulled toward (3.4, 0)
    g.telemetry(a["id"], a["token"], sightings=[{"marker_id": 2, "dist": 2.0}])
    assert pb["pos"][0] < 5.0 and pb["pos"][1] < 5.0
    m = g.map_data()
    assert m[a["id"]]["seen"][0]["id"] == b["id"]
    assert m[a["id"]]["moving"] and m[a["id"]]["online"]
    with pytest.raises(GameError, match="token"):
        g.telemetry(a["id"], "nope", heading=0)


def test_reset_returns_to_lobby():
    g, _a, _ = join2()
    g.start()
    g.reset()
    assert g.phase == "lobby"


# ---------- HTTP smoke test ----------


def _req(base, path, method="GET", body=None, token=None):
    req = urllib.request.Request(base + path, method=method)
    if body is not None:
        req.data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("X-Player-Token", token)
    with urllib.request.urlopen(req, timeout=3) as r:
        return r.status, r.read()


def test_http_flow():
    game = Game()
    srv = make_server(0, game)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        status, body = _req(base, "/health")
        assert status == 200 and json.loads(body)["status"] == "ok"
        status, body = _req(base, "/")
        assert b"<title>SPLAT</title>" in body

        _, body = _req(base, "/api/join", "POST", {"name": "a", "marker_id": 7})
        p = json.loads(body)["player"]
        assert p["marker_id"] == 7

        _req(base, "/api/admin", "POST", {"action": "start"})
        _, body = _req(base, "/api/state")
        assert json.loads(body)["phase"] == "running"

        _, body = _req(
            base, "/api/hit", "POST", {"player_id": p["id"], "marker_id": 7}, p["token"]
        )
        assert json.loads(body)["result"] == "own_marker"
    finally:
        srv.shutdown()
        srv.server_close()
