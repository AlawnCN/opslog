set -eu
decode_arg() { if [ "$1" = "-" ]; then return 0; fi; printf '%s' "$1" | perl -pe 's/([0-9a-f]{2})/chr(hex($1))/ge'; }
root=$(decode_arg "$1")
if [ ! -d "$root" ]; then
  parent=$(dirname "$root")
  if [ "$(basename "$root")" = "$(basename "$parent")" ] && [ -d "$parent/log" ] && [ -d "$parent/trc" ]; then root=$parent; fi
fi
days=$(decode_arg "$2")
start_time=$(decode_arg "$3")
end_time=$(decode_arg "$4")
limit=$(decode_arg "$5")
txn_id=$(decode_arg "$6")
txn_no=$(decode_arg "$7")
business=$(decode_arg "$8")
service=$(decode_arg "$9")
shift 9
node=$(decode_arg "$1")
message_code=$(decode_arg "$2")
message_info=$(decode_arg "$3")
minimum_duration=$(decode_arg "$4")
status=$(decode_arg "$5")
seen=''
list_truncated=0
emit_file() {
  file=$1
  [ -f "$file" ] || return 0
  case " $seen " in *" $file "*) return 0;; esac
  seen="$seen $file"
  size=$(wc -c < "$file")
  if [ "$size" -gt 8388608 ]; then
    list_truncated=1
    tail -c 8388608 "$file" | sed '1d'
  else
    cat -- "$file"
  fi
}
stream_files() {
  for file in "$root"/log/txn_*.lst; do emit_file "$file"; done
  oldifs=$IFS
  IFS=,
  for day in $days; do
    for file in "$root"/log/"$day"/txn_*.lst; do emit_file "$file"; done
  done
  IFS=$oldifs
  if [ "$list_truncated" -eq 1 ]; then printf '@OPSLOG_SCAN_LIMIT\t交易列表仅扫描文件末尾片段，结果可能不完整\n'; fi
}
stream_files | perl -e '
use strict;
use warnings;
use Encode qw(decode encode);
my ($start, $end, $limit, $id, $no, $business, $service, $node, $code_filter, $info, $minimum, $status) = @ARGV;
$limit = int($limit);
$minimum = 0 + ($minimum || 0);
sub matches { my ($value, $needle) = @_; return !$needle || index(lc($value), lc($needle)) >= 0; }
my @top;
my $scan_warning = "";
my $retain = sub {
  my ($stamp, $row) = @_;
  if (@top < $limit) {
    push @top, [$stamp, $row];
    my $index = $#top;
    while ($index > 0) {
      my $parent = int(($index - 1) / 2);
      last if $top[$parent][0] le $top[$index][0];
      @top[$parent, $index] = @top[$index, $parent];
      $index = $parent;
    }
  } elsif ($stamp gt $top[0][0]) {
    $top[0] = [$stamp, $row];
    my $index = 0;
    while (2 * $index + 1 < @top) {
      my $child = 2 * $index + 1;
      $child++ if $child + 1 < @top && $top[$child + 1][0] lt $top[$child][0];
      last if $top[$index][0] le $top[$child][0];
      @top[$index, $child] = @top[$child, $index];
      $index = $child;
    }
  }
};
LINE: while (my $line = <STDIN>) {
  $line =~ s/\r?\n$//;
  if ($line =~ /^\@OPSLOG_SCAN_LIMIT\t(.*)$/) { $scan_warning = $1; next; }
  my ($stamp, $body) = $line =~ /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.,]\d{3})\s+->\s+\|(.*)\|$/;
  next unless defined $body;
  $stamp =~ tr/,/./;
  next if $stamp lt $start || $stamp ge $end;
  my @fields;
  my $cursor = 0;
  for (1..9) {
    my $separator = index($body, "|", $cursor);
    next LINE if $separator < 0;
    push @fields, substr($body, $cursor, $separator - $cursor);
    $cursor = $separator + 1;
  }
  my $context_end;
  if (substr($body, $cursor, 1) eq "{") {
    my ($depth, $quoted, $escaped) = (0, 0, 0);
    for (my $index = $cursor; $index < length($body); $index++) {
      my $character = substr($body, $index, 1);
      if ($escaped) { $escaped = 0; next; }
      if ($quoted && $character eq "\\") { $escaped = 1; next; }
      if ($character eq "\"") { $quoted = !$quoted; next; }
      next if $quoted;
      $depth++ if $character eq "{";
      if ($character eq "}" && --$depth == 0) { $context_end = $index + 1; last; }
    }
  } else {
    $context_end = index($body, "|", $cursor);
  }
  next if !defined($context_end) || $context_end < 0 || substr($body, $context_end, 1) ne "|";
  my $tail = substr($body, $context_end + 1);
  my $code_end = index($tail, "|");
  my $source_start = rindex($tail, "|");
  next if $code_end < 0 || $source_start <= $code_end;
  my $code = substr($tail, 0, $code_end);
  my $message = substr($tail, $code_end + 1, $source_start - $code_end - 1);
  $message =~ s/\|$//;
  my $source = substr($tail, $source_start + 1);
  next unless matches($fields[0], $id) && matches($fields[1], $no)
    && matches($fields[4], $business) && matches($fields[5], $service)
    && matches($fields[3], $node) && matches($code, $code_filter) && matches($message, $info);
  next if $minimum && (0 + $fields[6]) < $minimum;
  next if $status ne "ALL" && $status ne "" && $code eq "";
  next if $status eq "SUCCESS" && $code !~ /00000$/;
  next if $status eq "FAIL" && $code =~ /00000$/;
  # The full context and long message remain available in the per-transaction detail view.
  my $preview = encode("UTF-8", substr(decode("UTF-8", $message), 0, 4096));
  my $compact = "$stamp -> |" . join("|", @fields) . "|{}|$code|$preview|$source|\n";
  $retain->($stamp, $compact);
}
print $_->[1] for sort { $b->[0] cmp $a->[0] } @top;
print "\@OPSLOG_SCAN_LIMIT\t$scan_warning\n" if length $scan_warning;
' "$start_time" "$end_time" "$limit" "$txn_id" "$txn_no" "$business" "$service" "$node" "$message_code" "$message_info" "$minimum_duration" "$status"
