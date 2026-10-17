/** Standalone macOS installer; all arguments originate in the main-owned prepared operation. */
export const unsignedMacInstallHelper = `#!/bin/sh
set -eu
umask 077
export LC_ALL=C
target=$1
next=$2
backup=$3
parent=$4
parent_start=$5
target_identity=$6
next_identity=$7
operation=$8
expected_version=$9
bundle_executable=\${10}
swap="$operation/unsigned-mac-swap"
status() {
  printf '%s\\n' "$1" > "$operation/status.tmp.$$"
  /bin/mv -f "$operation/status.tmp.$$" "$operation/status"
  printf '%s %s\\n' "$(/bin/date -u +%FT%TZ)" "$1"
}
identity() { /usr/bin/stat -f '%d:%i' "$1"; }
rollback() {
  if [ -d "$target" ] && [ -d "$backup" ]; then
    if "$swap" "$target" "$backup" "$next_identity" "$target_identity"; then
      if /usr/bin/open -n "$target"; then status rolled-back; else status rollback-launch-failed; fi
    else status rollback-failed; fi
  else status rollback-failed; fi
}
status ready
count=0
while /bin/kill -0 "$parent" 2>/dev/null; do
  if [ -f "$operation/cancelled" ]; then status cancelled; exit 1; fi
  actual_start=$(/bin/ps -p "$parent" -o lstart= 2>/dev/null | /usr/bin/sed 's/[[:space:]]*$//' || true)
  [ "$actual_start" = "$parent_start" ] || break
  count=$((count + 1))
  if [ "$count" -gt 120 ]; then status parent-did-not-exit; exit 1; fi
  /bin/sleep 1
done
if [ ! -f "$operation/authorized" ] || [ -f "$operation/cancelled" ]; then status cancelled; exit 1; fi
if [ ! -d "$target" ] || [ -L "$target" ] || [ "$(identity "$target")" != "$target_identity" ] \\
  || [ ! -d "$next" ] || [ -L "$next" ] || [ "$(identity "$next")" != "$next_identity" ]; then
  status install-target-changed; exit 1
fi
if [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$target/Contents/Info.plist")" != "$expected_version" ]; then
  status install-target-changed; exit 1
fi
if ! /usr/bin/codesign --verify --deep --strict "$next"; then status staged-app-invalid; exit 1; fi
users=$(/usr/sbin/lsof -n -t "$target/Contents/MacOS/$bundle_executable" 2> "$operation/lsof-error") || true
if [ -n "$users" ]; then status target-in-use; exit 1; fi
if [ -s "$operation/lsof-error" ]; then status target-in-use-check-failed; exit 1; fi
status replacing
if ! "$swap" "$target" "$next" "$target_identity" "$next_identity"; then status backup-failed; exit 1; fi
status launching
if ! /usr/bin/open -n "$target"; then
  rollback
  exit 1
fi
count=0
while [ "$count" -lt 60 ]; do
  if [ -f "$operation/acknowledged" ] && [ ! -L "$operation/acknowledged" ]; then status succeeded; exit 0; fi
  count=$((count + 1))
  /bin/sleep 1
done
status launch-unconfirmed
exit 1
`
