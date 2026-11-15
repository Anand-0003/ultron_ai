#!/bin/zsh
# Saves (or changes) the Mac login password ULTRON types when waking the screen.
# Stored in your macOS Keychain, never in the project files.
read -s "pw?Mac login password: "; echo
[ -n "$pw" ] || { echo "Nothing entered."; exit 1; }
security add-generic-password -a "$USER" -s ultron-unlock -l "ULTRON screen unlock" -w "$pw" -U && echo "Saved to Keychain."
# To remove it:  security delete-generic-password -s ultron-unlock
