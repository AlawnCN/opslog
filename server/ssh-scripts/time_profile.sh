set -eu
zone=$(timedatectl show -p Timezone --value 2>/dev/null || true)
[ -n "$zone" ] || zone=$(cat /etc/timezone 2>/dev/null || true)
offset=$(date +%:z)
printf '%s\n%s\n' "$zone" "$offset"
