#!/bin/zsh
cd -- "${0:A:h}" || exit 1
python3 scripts/connect_hosted.py
