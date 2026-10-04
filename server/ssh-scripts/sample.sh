set -eu
decode_arg() { printf '%s' "$1" | perl -pe 's/([0-9a-f]{2})/chr(hex($1))/ge'; }
root=$(decode_arg "$1")
perl -MEncode -e '
use strict; use warnings;
# OPSLOG_JSON_CODEC
my $root=shift; my @files; my $entries=0;
for my $kind (qw(log trc)) {
  next if -l "$root/$kind";
  my @dirs=("$root/$kind");
  opendir my $base,"$root/$kind" or next;
  for (readdir $base) { push @dirs,"$root/$kind/$_" if /^\d{2}$/ && -d "$root/$kind/$_" && !-l "$root/$kind/$_"; }
  closedir $base;
  for my $dir (@dirs) {
    opendir my $handle,$dir or next;
    while (my $name=readdir $handle) {
      last if ++$entries>6000;
      next if $name !~ /\.(trc|log|lst)(\.\d+)?$/ || -l "$dir/$name";
      push @files,"$dir/$name" if -f "$dir/$name";
    }
    closedir $handle;
  }
}
my %types; my $count=0;
sub priority {my $p=shift; return 0 if $p=~/\/txn_.*\.lst/; return 1 if $p=~/\/txntrc_/; return 2 if $p=~/\/transaction_/; return 3;}
for my $path (sort {priority($a)<=>priority($b) || (stat($b))[9]<=>(stat($a))[9]} @files) {
  my $relative=substr($path,length($root)+1);
  my $type=$relative; $type=~s{/\d{2}/}{/{day}/}; $type=~s/[-_.]\d+(?=[-.]|$)/_N/g;
  next if $types{$type}++>0;
  last if $count++>=12;
  open my $file,"<:raw",$path or next; my $size=-s $file;
  read($file,my $head,4096); my $tail="";
  if ($size>4096) { seek($file,$size>8192?$size-4096:4096,0); read($file,$tail,4096); }
  my $content=decode("UTF-8",$head."\n[TAIL SAMPLE]\n".$tail,Encode::FB_DEFAULT);
  $content=~s/((?:password|passwd|api[_-]?key|authorization|access[_-]?token)\s*[":=]+\s*)[^\s,;}]+/${1}[REDACTED]/ig;
  print Encode::encode("UTF-8","{\"path\":".json_string($relative).",\"size\":$size,\"content\":".json_string($content)."}\n");
}
' "$root"
