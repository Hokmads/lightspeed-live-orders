#!/usr/bin/env bash
# Startup script for Lightspeed Live Orders Dashboard
cd "$(dirname "$0")" || exit 1

echo "Starting Lightspeed Live Orders Server..."
python3 server.py
