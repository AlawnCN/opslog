set -eu
decode_arg() { printf '%s' "$1" | perl -pe 's/([0-9a-f]{2})/chr(hex($1))/ge'; }
root=$(decode_arg "$1")
perl -MEncode -MCwd=realpath -e '
use strict; use warnings;
# OPSLOG_JSON_CODEC
my $root=realpath(shift)//die "Invalid application directory"; my @files; my $entries=0;
my @dirs=grep {-d $_} ("$root/filebeat/trc","$root/log",$root); my %scanned;
while (@dirs && $entries<=6000) {
  my $dir=shift @dirs; next if -l $dir;
  next if $scanned{$dir}++;
  my $real=realpath($dir)//next; next unless $real eq $root || index($real,"$root/")==0;
  opendir my $handle,$dir or next;
  while (defined(my $name=readdir $handle)) {
    next if $name eq "." || $name eq "..";
    last if ++$entries>6000;
    my $path="$dir/$name"; next if -l $path;
    if (-d $path) { push @dirs,$path; next; }
    next if $name !~ /\.(trc|log|lst|txt|out)(\.\d+)?$/;
    push @files,$path if -f $path;
  }
  closedir $handle;
}
my %types; my $count=0; my $summary_selected=0;
sub priority {my $p=shift; return 0 if $p=~/\.lst$/; return 1 if $p=~/\/txntrc_/; return 2 if $p=~/\/transaction_/; return 3;}
for my $path (sort {priority($a)<=>priority($b) || (stat($b))[9]<=>(stat($a))[9] || $a cmp $b} @files) {
  my $summary=$path=~/\.lst$/ ? 1 : 0;
  next if $summary && $summary_selected;
  my $relative=substr($path,length($root)+1);
  my $type=$relative; $type=~s{/\d{2}/}{/{day}/}; $type=~s/[-_.]\d+(?=[-.]|$)/_N/g;
  next if $types{$type}++>0;
  last if $count++>=12;
  open my $file,"<:raw",$path or next; my $size=-s $file;
  $summary_selected=1 if $summary;
  my $modified=(stat($file))[9];
  my $window=$summary?65536:4096;
  read($file,my $head,$window); my $tail="";
  if ($size>$window) {
    my $position=$size>2*$window?$size-$window:$window;
    seek($file,$position,0); read($file,$tail,$window);
    # Never send a torn summary record: its missing result columns would cause
    # the model to infer the wrong schema. The first tail record is partial.
    $head=~s/[^\n]*$// if $summary;
    $tail=~s/^[^\n]*\n// if $summary;
  }
  if ($summary) {
    my @head=split /\n/,$head; my @tail=split /\n/,$tail;
    @tail=@head[$#head-5..$#head] if !@tail && @head>6;
    @head=@head[0..5] if @head>6; @tail=@tail[$#tail-5..$#tail] if @tail>6;
    $head=join("\n",@head); $tail=join("\n",@tail);
  }
  my $content=decode("UTF-8",$head."\n[TAIL SAMPLE]\n".$tail,Encode::FB_DEFAULT);
  $content=~s/((?:password|passwd|api[_-]?key|authorization|access[_-]?token)\s*[":=]+\s*)[^\s,;}]+/${1}[REDACTED]/ig;
  print Encode::encode("UTF-8","{\"path\":".json_string($relative).",\"size\":$size,\"modifiedAt\":$modified,\"summarySelected\":".($summary?"true":"false").",\"content\":".json_string($content)."}\n");
}
' "$root"
