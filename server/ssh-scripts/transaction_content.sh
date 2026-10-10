set -eu
decode_arg() { if [ "$1" = "-" ]; then return 0; fi; printf '%s' "$1" | perl -pe 's/([0-9a-f]{2})/chr(hex($1))/ge'; }
root=$(decode_arg "$1")
if [ ! -d "$root" ]; then
  printf '%s\n' 'Configured application directory does not exist; refusing to search parent directories' >&2
  exit 1
fi
log_id=$(decode_arg "$2")
days=$(decode_arg "$3")
root=$(perl -MCwd=realpath -e 'print realpath($ARGV[0])//""' "$root")
[ -n "$root" ] || exit 0
remaining=16777216
truncated=0
oldifs=$IFS
IFS=,
for day in $days; do
  directory="$root/trc/$day"
  [ -d "$directory" ] || continue
  for file in "$directory/$log_id.trc"; do
    [ -f "$file" ] || continue
    resolved=$(perl -MCwd=realpath -e 'print realpath($ARGV[0])//""' "$file")
    case "$resolved" in "$root"/*) ;; *) continue;; esac
    if [ "$remaining" -le 0 ]; then truncated=1; continue; fi
    printf '\n===== OPSLOG SOURCE: %s =====\n' "$(basename "$file")"
    size=$(wc -c < "$file")
    take=$size
    [ "$take" -le 4194304 ] || take=4194304
    [ "$take" -le "$remaining" ] || take=$remaining
    if [ "$size" -le "$take" ]; then
      cat -- "$file"
    else
      first=$((take / 2))
      last=$((take - first))
      head -c "$first" "$file"
      printf '\n[日志过大，中间内容已省略]\n'
      tail -c "$last" "$file"
      truncated=1
    fi
    remaining=$((remaining - take))
    printf '\n'
  done
done
IFS=$oldifs
if [ "$truncated" -eq 1 ]; then printf '\n[单笔日志已按读取预算截断]\n'; fi
