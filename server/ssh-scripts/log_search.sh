set -eu
decode_arg() { if [ "$1" = "-" ]; then return 0; fi; printf '%s' "$1" | perl -pe 's/([0-9a-f]{2})/chr(hex($1))/ge'; }
root=$(decode_arg "$1")
if [ ! -d "$root" ]; then
  printf '%s\n' 'Configured application directory does not exist; refusing to search parent directories' >&2
  exit 1
fi
days=$(decode_arg "$2")
start_time=$(decode_arg "$3")
end_time=$(decode_arg "$4")
limit=$(decode_arg "$5")
level=$(decode_arg "$6")
keyword=$(decode_arg "$7")
file_filter=$(decode_arg "$8")
output_mode=$(decode_arg "$9")
seen=''
emit_path() {
  file=$1
  [ -f "$file" ] || return 0
  case " $seen " in *" $file "*) return 0;; esac
  seen="$seen $file"
  name=$(basename "$file")
  case "$name" in txn_*.lst|txntrc_*.trc*) return 0;; esac
  if [ -n "$file_filter" ]; then case "$name" in *"$file_filter"*) ;; *) return 0;; esac; fi
  printf '%s\n' "$file"
}
stream_paths() {
  for file in "$root"/log/*.log "$root"/log/*.log.* "$root"/log/*.log_*; do emit_path "$file"; done
  oldifs=$IFS
  IFS=,
  for day in $days; do
    for file in "$root"/log/"$day"/*.log "$root"/log/"$day"/*.log.* "$root"/log/"$day"/*.log_*; do emit_path "$file"; done
  done
  IFS=$oldifs
}
stream_paths | perl -e '
use strict;
use warnings;
use Encode qw(decode encode);
use File::Basename qw(basename);
use Cwd qw(realpath);
use Time::Local qw(timegm);
my ($root, $start, $end, $limit, $level, $keyword, $output_mode) = @ARGV;
my $realroot = realpath($root) // die "Invalid application directory";
$limit = int($limit);
my $first_year = substr($start, 0, 4);
my $last_year = substr($end, 0, 4);
sub day_epoch {
  my ($year, $month, $day) = @_;
  return eval { timegm(0, 0, 0, $day, $month - 1, $year) };
}
my $start_day = day_epoch(substr($start, 0, 4), substr($start, 5, 2), substr($start, 8, 2));
my $end_day = day_epoch(substr($end, 0, 4), substr($end, 5, 2), substr($end, 8, 2));
my $max_record_bytes = int(48 * 1024 * 1024 / $limit);
$max_record_bytes = 65536 if $max_record_bytes > 65536;
my @top;
my $budget = 8 * 1024 * 1024;
my $truncated = 0;
my $file_count = 0;
sub timestamp {
  my ($record, $structured) = @_;
  my $stamp;
  if ($structured) { my @fields = split(/ §§ /, $record, 3); $stamp = $fields[1]; }
  else {
    my ($short) = $record =~ /^[A-Z]+\d*\[(\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.,]\d{3})\]/;
    return unless defined $short;
    $stamp = "$first_year-$short";
    $stamp = "$last_year-$short" if $stamp lt $start && $last_year ne $first_year;
  }
  return unless defined $stamp && $stamp =~ /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.,]\d{3}/;
  $stamp = substr($stamp, 0, 23); $stamp =~ tr/,/./; return $stamp;
}
# Ordered newline logs can seek near the exclusive end of a historical query.
# Failed probes fall back to bounded reverse chunks, never a full file read.
sub end_position {
  my ($file, $size, $structured) = @_; my ($left, $right) = (0, $size);
  my $separator = $structured ? " §§ logEnd" : "\n";
  while ($left < $right && $budget > 65536) {
    my $middle = int(($left + $right) / 2); seek($file, $middle, 0);
    my $count = read($file, my $chunk, 65536); $budget -= $count;
    my $begin = $middle;
    if ($middle) { my $boundary = index($chunk, $separator); return $size if $boundary < 0; $begin += $boundary + length($separator); $chunk = substr($chunk, $boundary + length($separator)); }
    my $boundary = index($chunk, $separator); return $size if $boundary < 0;
    my $stamp = timestamp(substr($chunk, 0, $boundary), $structured); return $size unless defined $stamp;
    if ($stamp ge $end) { $right = $middle; } else { $left = $begin + $boundary + length($separator); }
  }
  return $left < $right ? $size : $left;
}
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
my @paths;
while (my $path = <STDIN>) {
  chomp $path; push @paths, $path;
  if (@paths >= 6000) { $truncated = 1; last; }
}
for my $path (sort { (stat($b))[9] <=> (stat($a))[9] } @paths) {
  my $real = realpath($path) // next;
  next unless index($real, "$realroot/") == 0;
  if (++$file_count > 64 || $budget <= 0) { $truncated = 1; last; }
  my $source = basename($path);
  if ($source =~ /(20\d{2})-(\d{2})-(\d{2})/) {
    my $file_day = day_epoch($1, $2, $3);
    next if defined($file_day) && defined($start_day) && defined($end_day)
      && ($file_day < $start_day - 86400 || $file_day > $end_day + 86400);
  }
  open my $file, "<:raw", $path or next;
  my $sample = "";
  my $probe = $budget < 65536 ? $budget : 65536;
  $budget -= read($file, $sample, $probe);
  my $structured = index($sample, " §§ logEnd") >= 0;
  my $position = -s $file;
  $position = end_position($file, $position, $structured);
  my $pending = ""; my $separator = $structured ? " §§ logEnd" : "\n";
  while ($position > 0 && $budget > 0) {
    my $length = $position < 65536 ? $position : 65536;
    $length = $budget if $length > $budget;
    $position -= $length; seek($file, $position, 0);
    my $count = read($file, my $chunk, $length); $budget -= $count;
    last unless $count;
    my @records = split(/\Q$separator\E/, $chunk . $pending, -1);
    $pending = $position ? shift(@records) : "";
    for my $record (reverse @records) {
    $record =~ s/ §§ logEnd$// if $structured;
    my $stamp;
    if ($structured) {
      my @fields = split(/ §§ /, $record, 3);
      $stamp = $fields[1] if @fields >= 3;
      next if $level ne "" && index($record, "§§ $level §§") < 0;
    } else {
      my ($raw_level, $local_time) = $record =~ /^([A-Z]+)\d*\[(\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.,]\d{3})\]/;
      next unless defined $local_time;
      next if $level ne "" && index($raw_level, $level) < 0;
      $stamp = "$first_year-$local_time";
      $stamp =~ tr/,/./;
      if ($stamp lt $start && $last_year ne $first_year) { $stamp = "$last_year-$local_time"; }
    }
    next unless defined $stamp && $stamp =~ /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.,]\d{3}/;
    $stamp = substr($stamp, 0, 23);
    $stamp =~ tr/,/./;
    next if $stamp lt $start || $stamp ge $end;
    next if $keyword ne "" && index(lc($record), lc($keyword)) < 0;
    if ($output_mode eq "PREVIEW" && length($record) > $max_record_bytes) {
      $record = encode("UTF-8", substr(decode("UTF-8", substr($record, 0, $max_record_bytes - 32)), 0)) . "\n[日志内容已截断]";
    }
    $retain->($stamp, "$source\x1f$record\x1e");
    }
  }
  $truncated = 1 if $position > 0;
  close $file;
}
print $_->[1] for sort { $b->[0] cmp $a->[0] } @top;
print "\n\@OPSLOG_SCAN_LIMIT\tSSH log scan reached the 8 MiB / 64 file budget; results may be incomplete\n" if $truncated;
' "$root" "$start_time" "$end_time" "$limit" "$level" "$keyword" "$output_mode"
