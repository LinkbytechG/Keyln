#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd -- "${0:A:h}" || exit 1
keyln_data_dir="${KEYLN_DATA_DIR:-$HOME/Library/Application Support/Keyln}"
if ! command -v npm >/dev/null 2>&1; then
  print 'Keyln needs Node.js and npm on this Mac. See README.md.'
  read -k 1 '?Press any key to close.'
  exit 1
fi
if [[ -e "$keyln_data_dir/service.json" || -L "$keyln_data_dir/service.json" ]]; then
  node scripts/service.mjs start
  keyln_exit_code=$?
  print 'For a login code, open Manage-Keyln.command. Keyln keeps running in the background; you can close this window.'
  if (( keyln_exit_code != 0 )); then read -k 1 '?Keyln could not start. Read the message above, then press any key to close.'; fi
  exit "$keyln_exit_code"
fi
npm start
keyln_exit_code=$?
if (( keyln_exit_code != 0 )); then
  read -k 1 '?Keyln could not start. Read the message above, then press any key to close.'
fi
exit "$keyln_exit_code"
