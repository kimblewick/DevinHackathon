#!/usr/bin/env bash
# Runs on the Pi. Fallback used by deploy.sh when the organisers' helper
# commands (deploy / app-restart) are not available. Installs a systemd
# unit that runs start.sh (the same entry point the organisers use).
set -euo pipefail

PI_DIR="${1:-$HOME/app}"
PI_USER="${2:-$USER}"
SERVICE_NAME="devinhackathon"

cd "$PI_DIR"

sudo tee "/etc/systemd/system/$SERVICE_NAME.service" > /dev/null <<EOF
[Unit]
Description=DevinHackathon Pi app
After=network.target

[Service]
Type=simple
User=$PI_USER
WorkingDirectory=$PI_DIR
Environment=PORT=3000
ExecStart=/bin/bash $PI_DIR/start.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"
sudo systemctl status "$SERVICE_NAME" --no-pager
