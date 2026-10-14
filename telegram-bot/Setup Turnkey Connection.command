#!/bin/zsh
cd -- "${0:A:h}" || exit 1
python3 scripts/turnkey_setup.py
read -r '?Press Enter to close.'
