#!/bin/zsh
cd -- "${0:A:h}" || exit 1
python3 scripts/check_mainnet.py
read -r '?Press Enter to close.'
