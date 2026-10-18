from __future__ import annotations

import logging
import os
import signal
import ssl
import sys
import threading

from .game import Game
from .server import make_server

try:
    from gpiozero import LED
    from gpiozero.exc import BadPinFactory
except ImportError:
    LED = None
    BadPinFactory = OSError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("devinhackathon")

LED_PIN = int(os.environ.get("LED_PIN", "17"))
PORT = int(os.environ.get("PORT", "3000"))
TLS_PORT = int(os.environ.get("TLS_PORT", "3443"))
TLS_CERT = os.environ.get("TLS_CERT", "certs/cert.pem")
TLS_KEY = os.environ.get("TLS_KEY", "certs/key.pem")


def create_led(pin: int) -> LED | None:
    if LED is None:
        return None
    try:
        return LED(pin)
    except (BadPinFactory, OSError) as exc:
        logger.warning("GPIO unavailable (%s)", exc)
        return None


def lan_ip() -> str | None:
    import socket

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return None


def ensure_cert(cert: str, key: str) -> bool:
    if os.path.exists(cert) and os.path.exists(key):
        return True
    import socket
    import subprocess

    host = socket.gethostname().split(".")[0]
    sans = [f"DNS:{host}", f"DNS:{host}.local", "DNS:localhost", "IP:127.0.0.1"]
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            sans.append(f"IP:{s.getsockname()[0]}")
    except OSError:
        pass
    try:
        os.makedirs(os.path.dirname(cert) or ".", exist_ok=True)
        subprocess.run(
            [
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                "-days", "365", "-subj", f"/CN={host}.local",
                "-addext", "subjectAltName=" + ",".join(sans),
                "-keyout", key, "-out", cert,
            ],
            check=True,
            capture_output=True,
        )
        return True
    except (OSError, subprocess.CalledProcessError) as exc:
        logger.warning("could not generate TLS cert (%s); https disabled", exc)
        return False


def main() -> None:
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    game = Game()

    led = create_led(LED_PIN)
    if led is not None:
        game.on_event = lambda *_: led.toggle()

    httpd = make_server(PORT, game)
    httpd.lan_ip = lan_ip()
    servers = [httpd]

    if TLS_PORT and ensure_cert(TLS_CERT, TLS_KEY):
        tls = make_server(TLS_PORT, game)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(TLS_CERT, TLS_KEY)
        tls.socket = ctx.wrap_socket(tls.socket, server_side=True)
        servers.append(tls)
        httpd.tls_port = tls.tls_port = TLS_PORT
        tls.lan_ip = httpd.lan_ip
        logger.info("https on :%d (self-signed — live AR camera mode)", TLS_PORT)

    for srv in servers[1:]:
        threading.Thread(target=srv.serve_forever, daemon=True).start()

    logger.info("http on :%d — game server ready", PORT)
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for srv in servers:
            srv.server_close()
        if led is not None:
            led.close()
    logger.info("stopped")
