#!/usr/bin/env bash
# Entry point required by the hackathon Pi host. nginx forwards :80 here.
set -euo pipefail
cd "$(dirname "$0")"

export PORT="${PORT:-3000}"
# Self-signed HTTPS listener: iPhones only allow live camera on HTTPS.
export TLS_PORT="${TLS_PORT:-3443}"
export TLS_CERT="${TLS_CERT:-certs/cert.pem}"
export TLS_KEY="${TLS_KEY:-certs/key.pem}"
export PYTHONPATH="$PWD/src${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONUNBUFFERED=1

if [[ -x .venv/bin/python ]]; then
  PYTHON=.venv/bin/python
else
  PYTHON=python3
fi

exec "$PYTHON" -m devinhackathon
