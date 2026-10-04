set -eu
decode_arg() { if [ "$1" = "-" ]; then return 0; fi; printf '%s' "$1" | perl -pe 's/([0-9a-f]{2})/chr(hex($1))/ge'; }
root=$(decode_arg "$1")
if [ ! -d "$root" ]; then
  parent=$(dirname "$root")
  if [ "$(basename "$root")" = "$(basename "$parent")" ] && [ -d "$parent/log" ] && [ -d "$parent/trc" ]; then root=$parent; fi
fi
days=$(decode_arg "$2")
txn_id=$(decode_arg "$3")
txn_no=$(decode_arg "$4")
business=$(decode_arg "$5")
service=$(decode_arg "$6")
node=$(decode_arg "$7")
message_code=$(decode_arg "$8")
message_info=$(decode_arg "$9")
shift 9
start_time=$(decode_arg "$1")
end_time=$(decode_arg "$2")
limit=$(decode_arg "$3")
minimum_duration=$(decode_arg "$4")
stream_summaries() {
  oldifs=$IFS
  IFS=,
  for day in $days; do
    for file in "$root"/trc/"$day"/transaction_*.trc; do
      [ -f "$file" ] && printf '%s\n' "$file"
    done
  done
  IFS=$oldifs
}
stream_summaries | perl -e '
use strict;
use warnings;
use File::Basename qw(dirname);
my ($start, $end, $limit, $id_filter, @needles) = @ARGV;
my $minimum = pop @needles;
$limit = int($limit);
$minimum = 0 + ($minimum || 0);
@needles = grep { length } map { lc($_) } @needles;
my $summary_budget = 8 * 1024 * 1024;
my $detail_budget = 16 * 1024 * 1024;
my (%records, $parsed, $incomplete);
sub line_stamp {
  my ($line, $year) = @_;
  my ($clock) = $line =~ /\[(\d{2}-\d{2} \d{2}:\d{2}:\d{2}[,.]\d{3})\]/;
  return unless defined $clock;
  $clock =~ tr/,/./;
  return "$year-$clock";
}
sub end_position {
  my ($file, $size, $year) = @_;
  my ($left, $right) = (0, $size);
  while ($left < $right) {
    my $middle = int(($left + $right) / 2);
    my $line_start = $middle;
    if ($middle) {
      seek($file, $middle - 1, 0) or return;
      read($file, my $previous, 1) == 1 or return;
      if ($previous ne "\n") {
        seek($file, $middle, 0) or return;
        read($file, my $partial, 65536) or return;
        my $separator = index($partial, "\n");
        return if $separator < 0;
        $line_start += $separator + 1;
      }
    }
    seek($file, $line_start, 0) or return;
    my $read = read($file, my $line, 65536);
    if (!$read) { $right = $middle; next; }
    my $separator = index($line, "\n");
    return if $separator < 0 && $line_start + $read < $size;
    $line = substr($line, 0, $separator) if $separator >= 0;
    my $stamp = line_stamp($line, $year);
    return unless defined $stamp;
    if ($stamp ge $end) { $right = $middle; }
    else { $left = $line_start + length($line) + ($separator >= 0 ? 1 : 0); }
  }
  return $left;
}
sub collect_line {
  my ($line, $year, $directory) = @_;
  my $stamp = line_stamp($line, $year);
  return 0 unless defined $stamp;
  return -1 if $stamp lt $start;
  return 0 if $stamp ge $end;
  my @fields = split(/\|/, $line);
  return 0 if @fields < 5;
  my ($id) = $fields[0] =~ / -> ([A-Za-z0-9._-]+)\s*$/;
  return 0 unless defined $id;
  $parsed++;
  my $key = "$directory\0$id";
  my $record = $records{$key} //= { stamp => $stamp, id => $id, directory => $directory, business => "", service => "", duration => 0 };
  $record->{stamp} = $stamp if $stamp lt $record->{stamp};
  my ($business, $service, $ignored, $duration) = @fields[1..4];
  return 0 if $service eq "null" || $service eq "TxJnlInterceptor" || $service eq "IdempotentInterceptor" || $service eq "AntiRepeatFilterComponent";
  if (0 + $duration >= $record->{duration}) {
    $record->{business} = $business;
    $record->{service} = $service;
    $record->{duration} = int(0 + $duration + 0.5);
  }
  return 0;
}
my @paths = sort { (stat($b))[9] <=> (stat($a))[9] } map { chomp; $_ } <STDIN>;
my $scanned_paths = 0;
for my $path (@paths) {
  $scanned_paths++;
  my @stat = stat($path);
  next unless @stat;
  my $year = (localtime($stat[9]))[5] + 1900;
  my $directory = dirname($path);
  open my $file, "<:raw", $path or next;
  read($file, my $sample, 8192);
  $parsed++ if defined $sample && defined line_stamp($sample, $year) && $sample =~ / -> [A-Za-z0-9._-]+\s*\|/;
  my $position = end_position($file, $stat[7], $year);
  if (!defined $position) { $position = $stat[7]; $incomplete = 1; }
  my $remainder = "";
  my $finished = 0;
  while ($position > 0 && $summary_budget > 0) {
    my $length = $position < 65536 ? $position : 65536;
    $length = $summary_budget if $length > $summary_budget;
    $position -= $length;
    seek($file, $position, 0) or last;
    my $read = read($file, my $chunk, $length);
    last unless $read;
    $summary_budget -= $read;
    my @lines = split(/\n/, $chunk . $remainder, -1);
    $remainder = $position ? shift @lines : "";
    for my $line (reverse @lines) {
      my $state = collect_line($line, $year, $directory);
      if ($state < 0) { $finished = 1; last; }
    }
    last if $finished;
  }
  $incomplete = 1 if !$finished && $position > 0;
  close $file;
  last unless $summary_budget;
}
$incomplete = 1 if $scanned_paths < @paths;
print "\@OPSLOG_SUMMARY_PARSED\t", ($parsed || 0), "\n";
my %detail_files;
if (@needles) {
  my %directories = map { $_->{directory} => 1 } values %records;
  for my $directory (keys %directories) {
    opendir my $dir, $directory or next;
    while (my $name = readdir $dir) {
      next unless $name =~ /^([A-Za-z0-9._-]+)[.]trc$/;
      my $id = $1;
      $id =~ s/-[0-9]+$//;
      push @{$detail_files{"$directory\0$id"}}, "$directory/$name" if exists $records{"$directory\0$id"};
    }
    closedir $dir;
  }
}
sub matches_details {
  my ($record) = @_;
  return 1 unless @needles;
  my @found = (0) x @needles;
  my $id = $record->{id};
  my $overlap = 0;
  for my $needle (@needles) { $overlap = length($needle) - 1 if length($needle) - 1 > $overlap; }
  for my $path (@{$detail_files{"$record->{directory}\0$id"} || []}) {
    if (!$detail_budget) { $incomplete = 1; last; }
    open my $file, "<:raw", $path or next;
    my $remaining = $detail_budget < 1048576 ? $detail_budget : 1048576;
    my $tail = "";
    while ($remaining > 0) {
      my $size = $remaining < 65536 ? $remaining : 65536;
      my $read = read($file, my $chunk, $size);
      last unless $read;
      $remaining -= $read;
      $detail_budget -= $read;
      my $lower = lc($tail . $chunk);
      for my $index (0..$#needles) {
        $found[$index] = 1 if !$found[$index] && index($lower, $needles[$index]) >= 0;
      }
      last unless grep { !$_ } @found;
      $tail = $overlap ? substr($lower, -$overlap) : "";
    }
    $incomplete = 1 if $remaining <= 0 && !eof($file) && (grep { !$_ } @found);
    close $file;
    last unless grep { !$_ } @found;
  }
  return !grep { !$_ } @found;
}
my $emitted = 0;
for my $record (sort { $b->{stamp} cmp $a->{stamp} } values %records) {
  next if $record->{stamp} lt $start || $record->{stamp} ge $end;
  next if length($id_filter) && index(lc($record->{id}), lc($id_filter)) < 0;
  next if $minimum && $record->{duration} < $minimum;
  next unless matches_details($record);
  my $service = $record->{service};
  ($service = $record->{id}) =~ s/[.][su]_0_.*$// unless length $service;
  for my $value ($record->{business}, $service) { $value =~ s/[\t\r\n]/ /g; }
  print "\@OPSLOG_DETAIL\t$record->{stamp}\t$record->{id}\t$record->{business}\t$service\t$record->{duration}\n";
  last if ++$emitted >= $limit;
}
print "\@OPSLOG_SCAN_LIMIT\t扫描达到预算上限，当前结果可能不完整\n" if $incomplete;
' "$start_time" "$end_time" "$limit" "$txn_id" "$txn_no" "$business" "$service" "$node" "$message_code" "$message_info" "$minimum_duration"
