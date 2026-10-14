#!/bin/zsh
cd -- "${0:A:h}" || exit 1
node src/demo.mjs
read -r '?Press Enter to close.'
