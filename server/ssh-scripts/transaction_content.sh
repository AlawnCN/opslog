set -eu
decode_arg() { if [ "$1" = "-" ]; then return 0; fi; printf '%s' "$1" | perl -pe 's/([0-9a-f]{2})/chr(hex($1))/ge'; }
root=$(decode_arg "$1")
if [ ! -d "$root" ]; then
  parent=$(dirname "$root")
  if [ "$(basename "$root")" = "$(basename "$parent")" ] && [ -d "$parent/log" ] && [ -d "$parent/trc" ]; then root=$parent; fi
fi
log_id=$(decode_arg "$2")
days=$(decode_arg "$3")
base=$(printf '%s' "$log_id" | sed -E 's/-[0-9]+$//')
found=0
remaining=16777216
truncated=0
oldifs=$IFS
IFS=,
for day in $days; do
  directory="$root/trc/$day"
  [ -d "$directory" ] || continue
  for file in "$directory/$base.trc" "$directory/$base"-[0-9]*.trc; do
    [ -f "$file" ] || continue
    found=1
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
if [ "$found" -eq 0 ]; then
  aggregate_found=0
  aggregate_seen=''
  aggregate_budget=33554432
  aggregate_truncated=0
  emit_aggregate() {
    file=$1
    [ -f "$file" ] || return 0
    case " $aggregate_seen " in *" $file "*) return 0;; esac
    aggregate_seen="$aggregate_seen $file"
    if [ "$aggregate_budget" -le 0 ]; then aggregate_truncated=1; return 0; fi
    size=$(wc -c < "$file")
    take=$size
    [ "$take" -le 4194304 ] || take=4194304
    [ "$take" -le "$aggregate_budget" ] || take=$aggregate_budget
    [ "$size" -le "$take" ] || aggregate_truncated=1
    aggregate_budget=$((aggregate_budget - take))
    matches=$(tail -c "$take" "$file" | grep -m 50 -F " §§ $base" | head -c 1048576 || true)
    if [ -n "$matches" ]; then
      if [ "$aggregate_found" -eq 0 ]; then
        printf '\n===== OPSLOG SOURCE: transaction aggregate =====\n'
        aggregate_found=1
      fi
      printf '%s\n' "$matches"
    fi
  }
  for file in "$root"/log/txntrc_*.trc "$root"/log/txntrc_*.trc.*; do emit_aggregate "$file"; done
  IFS=,
  for day in $days; do
    for file in "$root"/log/"$day"/txntrc_*.trc "$root"/log/"$day"/txntrc_*.trc.* "$root"/trc/"$day"/txntrc_*.trc "$root"/trc/"$day"/txntrc_*.trc.*; do emit_aggregate "$file"; done
  done
  IFS=$oldifs
  if [ "$aggregate_truncated" -eq 1 ]; then printf '\n[汇总日志仅搜索末尾片段，结果可能不完整]\n'; fi
fi
