#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd -- "${0:A:h}" || exit 1
node scripts/service.mjs admin
keyln_exit_code=$?
read -k 1 '?This window only shows the login code. Use a normal Terminal window for other commands. Press any key to close.'
exit "$keyln_exit_code"
