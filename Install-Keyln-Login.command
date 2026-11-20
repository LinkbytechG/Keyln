#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd -- "${0:A:h}" || exit 1
npm run service:install
keyln_exit_code=$?
print 'If a Host started by hand is still running, quit it before installing. After installing, open Manage-Keyln.command for a login code.'
read -k 1 '?Read the result above, then press any key to close.'
exit "$keyln_exit_code"
