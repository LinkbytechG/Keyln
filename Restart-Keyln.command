#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd -- "${0:A:h}" || exit 1
keyln_data_dir="${KEYLN_DATA_DIR:-$HOME/Library/Application Support/Keyln}"
if [[ -e "$keyln_data_dir/service.json" || -L "$keyln_data_dir/service.json" ]]; then
  npm run service:install
  keyln_exit_code=$?
  if (( keyln_exit_code != 0 )); then read -k 1 '?Keyln could not be updated. Read the message above, then press any key to close.'; fi
  exit "$keyln_exit_code"
fi
if ! node scripts/stop-host.mjs; then
  read -k 1 '?Keyln could not restart. Read the message above, then press any key to close.'
  exit 1
fi
exec ./Start-Keyln.command
