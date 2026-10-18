#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi

# Defaults target the hackathon Pi (pi-06) directly on the event Wi-Fi.
PI_HOST="${PI_HOST:-pi-06.local}"
PI_PORT="${PI_PORT:-22}"
PI_USER="${PI_USER:-hacker6}"
PI_DIR="${PI_DIR:-/home/$PI_USER/app}"

echo "Deploying to $PI_USER@$PI_HOST:$PI_DIR (ssh port $PI_PORT)"
ssh -p "$PI_PORT" "$PI_USER@$PI_HOST" "mkdir -p '$PI_DIR'"
rsync -az --delete -e "ssh -p $PI_PORT" \
  --exclude '.git' \
  --exclude '.venv' \
  --exclude '__pycache__' \
  --exclude '.pytest_cache' \
  --exclude '.ruff_cache' \
  --exclude '.env' \
  ./ "$PI_USER@$PI_HOST:$PI_DIR/"

# The organisers' `app` systemd service runs ~/app/start.sh with PORT=3000.
# Their `deploy` command is git-pull based, so we rsync and just restart.
ssh -p "$PI_PORT" "$PI_USER@$PI_HOST" "PI_DIR='$PI_DIR' PI_USER='$PI_USER' bash -s" <<'REMOTE'
set -e
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
cd "$PI_DIR"
if command -v app-restart >/dev/null 2>&1; then
  app-restart
else
  bash scripts/install.sh "$PI_DIR" "$PI_USER"
fi
REMOTE

echo "Deployed. Web app: http://$PI_HOST/"
