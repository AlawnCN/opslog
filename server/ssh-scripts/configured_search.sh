set -eu
decode_arg() { if [ "$1" = "-" ]; then return 0; fi; printf '%s' "$1" | perl -pe 's/([0-9a-f]{2})/chr(hex($1))/ge'; }
root=$(decode_arg "$1"); days=$(decode_arg "$2"); start=$(decode_arg "$3"); end=$(decode_arg "$4")
limit=$(decode_arg "$5"); kind=$(decode_arg "$6"); rules=$(decode_arg "$7"); filters=$(decode_arg "$8")
perl -MEncode -MCwd=realpath -e '
use strict; use warnings; use utf8;
# OPSLOG_JSON_CODEC
my ($root,$days,$start,$end,$limit,$kind,$rules,$filters)=@ARGV;
my $sources=decode_json($rules); my $query=decode_json($filters); my $budget=8*1024*1024;
my (%transactions,@rows,%visited,$truncated,%directories,$primary_transactions); my $entries=0; my $year=substr($start,0,4); my $end_year=substr($end,0,4);
my $realroot=realpath($root)//die "Invalid application directory";
$root=$realroot;
die "Invalid source count" unless ref($sources) eq "ARRAY" && @$sources<=12;
for my $source (@$sources) {
  die "Invalid file selection" unless ($source->{fileSelection}//"all")=~/^(all|latest)$/;
  $source->{successPattern}//="00000\$"; $source->{stripAsyncSuffix}//=1;
  die "Invalid fields" unless ref($source->{fields}) eq "HASH" && $source->{fields}{timestamp};
  for my $mapping(values %{$source->{fields}}) {if (defined $mapping->{regex}) {die "Unsafe regex" if length($mapping->{regex})>500 || $mapping->{regex}=~/\(\?\??\s*\{/; eval {qr/$mapping->{regex}/}; die "Invalid regex" if $@;}}
  die "Unsafe result regex" if length($source->{successPattern}//"")>200 || ($source->{successPattern}//"")=~/\(\?\??\s*\{/;
}
sub normalize_stamp {
  my ($stamp,$source)=@_; $stamp=~tr/,/./; $stamp=~s/T/ /; $stamp=~s/^\s+|\s+$//g;
  if ($source->{timestampStyle} eq "month-day") {my $short=$stamp; $stamp="$year-$short"; $stamp="$end_year-$short" if $year ne $end_year && ($stamp lt $start || $stamp ge $end);}
  return $stamp;
}
sub extract {
  my ($record,$parts,$mapping)=@_; return "" unless $mapping;
  if (defined $mapping->{regex}) { my $re=eval {qr/$mapping->{regex}/}; return "" unless $re; return $1//"" if $record=~$re; return ""; }
  return $parts->[$mapping->{index}]//"";
}
sub parts {
  my ($body,$separator)=@_; return ($body) unless length $separator;
  # Legacy summaries exist both with and without a leading pipe after ->.
  # Anchor the envelope so an arrow inside a JSON/message field is never stripped.
  $body=~s/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.,]\d{3}\s*->\s*\|?// if $separator eq "|";
  my (@fields,$field,$depth,$quoted,$escaped); $field=""; $depth=0;
  for (my $i=0;$i<length($body);$i++) {
    my $c=substr($body,$i,1);
    if (!$quoted && !$depth && substr($body,$i,length($separator)) eq $separator) {push @fields,$field; $field=""; $i+=length($separator)-1; next;}
    $field.=$c;
    if ($escaped) {$escaped=0;next;}
    if ($quoted && $c eq "\\") {$escaped=1;next;}
    if ($c eq "\"") {$quoted=!$quoted;next;}
    if (!$quoted) {$depth++ if $c eq "{" || $c eq "["; $depth-- if ($c eq "}" || $c eq "]") && $depth>0;}
  }
  push @fields,$field; return @fields;
}
sub record_row {
  my ($record,$source,$path)=@_; $record=decode("UTF-8",$record,Encode::FB_DEFAULT);
  my @parts=parts($record,$source->{delimiter}); my %values;
  for my $key (keys %{$source->{fields}}) {$values{$key}=extract($record,\@parts,$source->{fields}{$key}); $values{$key}=~s/^\s+|\s+$//g;}
  my $stamp=normalize_stamp($values{timestamp}//"",$source);
  return unless $stamp=~/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.]\d{3}$/;
  return if $stamp lt $start || $stamp ge $end;
  $values{timestamp}=$stamp; $values{message}=$record unless length($values{message}//"");
  my $id=$values{logId}//""; $id=~s/-\d+$// if $source->{stripAsyncSuffix}; $values{logId}=$id;
  $truncated=1 if $kind eq "detail" && length($record)>65536;
  my $row={values=>\%values,file=>$path,raw=>substr($record,0,65536),successPattern=>$source->{successPattern},role=>$source->{role}};
  if ($kind eq "detail") {return unless $id eq ($query->{txnId}//""); push @rows,$row; return;}
  if ($kind eq "transaction") {
    return unless length $id;
    # Summary rows are service-level facts, just like ELK documents. Only
    # transactionEvent sources opt into latest-fields/max-duration aggregation.
    if ($source->{role} eq "transaction") {$primary_transactions++ unless $source->{fallbackOnly}; push @rows,$row; return;}
    my $old=$transactions{$id};
    if (!$old) {$transactions{$id}=$row;}
    else {my $maximum=($values{duration}//0)>($old->{values}{duration}//0)?$values{duration}:$old->{values}{duration}; my $newer=$stamp gt $old->{values}{timestamp}; for my $key(keys %values) { $old->{values}{$key}=$values{$key} if ($newer || !length($old->{values}{$key}//"")) && length($values{$key}//""); } $old->{values}{duration}=$maximum if defined $maximum;}
  } else {push @rows,$row;}
}
sub record_stamp {
  my ($record,$source)=@_;
  $record=decode("UTF-8",$record,Encode::FB_DEFAULT);
  my @parts=parts($record,$source->{delimiter});
  my $stamp=extract($record,\@parts,$source->{fields}{timestamp});
  $stamp=normalize_stamp($stamp,$source);
  return $stamp if $stamp=~/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.]\d{3}$/;
  return;
}
sub end_position {
  my ($file,$size,$source)=@_; my ($left,$right)=(0,$size);
  while ($left<$right) {
    my $middle=int(($left+$right)/2); my $begin=$middle;
    seek($file,$middle,0); read($file,my $chunk,65536);
    if ($middle) { my $newline=index($chunk,"\n"); return unless $newline>=0; $begin+=$newline+1; $chunk=substr($chunk,$newline+1); }
    my $newline=index($chunk,"\n"); return unless $newline>=0;
    my $stamp=record_stamp(substr($chunk,0,$newline),$source); return unless defined $stamp;
    if ($stamp ge $end) {$right=$middle;} else {$left=$begin+$newline+1;}
  }
  return $left;
}
SOURCE: for my $source (sort {($a->{fallbackOnly}//0)<=>($b->{fallbackOnly}//0)} @$sources) {
  next if $kind eq "transaction" && $source->{fallbackOnly} && $primary_transactions;
  next if $kind eq "transaction" && $source->{role}!~/^transaction/;
  next if $kind eq "detail" && $source->{role}!~/^(detail|transactionEvent)$/;
  next if $kind eq "application" && $source->{role} ne "application";
  next if $kind eq "ecp" && $source->{role} ne "ecp";
  my @files;
  for my $pattern (@{$source->{paths}}) {
    if (($source->{pathMode}//"glob") eq "regex") {
      die "Unsafe file regex" if !length($pattern) || length($pattern)>240 || $pattern=~/[\x00-\x1f]/ || $pattern=~m{^\^?/} || $pattern=~m{(?:^\^?|/)\.\.(?:/|$)} || $pattern=~/\(\?\??\s*\{/;
      my $daily=index($pattern,"{day}")>=0;
      for my $day($daily ? split(/,/,$days) : ("")) {
        die "Unsafe day" if $daily && $day!~/^\d{2}$/;
        my $expanded=$pattern; $expanded=~s/\{day\}/$day/g;
        my $match=eval {qr/^(?:$expanded)$/}; die "Invalid file regex" unless $match;
        # Start at a literal directory prefix when possible; dynamic directories
        # are traversed within the same root and shared enumeration budget.
        my ($prefix)=$expanded=~m{^\^((?:[A-Za-z0-9_-]+/)+)};
        my @queue=(defined($prefix)?"$root/$prefix":$root);
        while (@queue) {
          my $directory=shift @queue; $directory=~s{/+$}{}; next if -l $directory;
          my $real=realpath($directory)//next;
          next unless $real eq $realroot || index($real,"$realroot/")==0;
          if (!exists $directories{$directory}) {
            opendir(my $handle,$directory) or next; my @names;
            while (defined(my $name=readdir($handle))) {
              next if $name eq "." || $name eq "..";
              if (++$entries>6000) {$truncated=1;last;}
              push @names,$name;
            }
            closedir($handle); $directories{$directory}=\@names;
          }
          for my $name (@{$directories{$directory}}) {
            my $path="$directory/$name"; next if -l $path;
            if (-d $path) { push @queue,$path if $entries<=6000; next; }
            my $relative=substr($path,length($root)); $relative=~s{^/+}{};
            push @files,$path if $relative=~$match;
          }
        }
      }
    } else {
      die "Unsafe path" if !length($pattern) || length($pattern)>240 || $pattern!~m{^[A-Za-z0-9_.*?{}/-]+$} || $pattern=~m{^/|(?:^|/)\.\.(?:/|$)};
      my $literal=$pattern; $literal=~s/\{day\}//g; die "Unsafe path" if $literal=~/[{}]/;
      for my $day(split /,/,$days) {my $p=$pattern; $p=~s/\{day\}/$day/g; push @files,glob("$root/$p");}
    }
  }
  my $files=0;
  for my $path(sort {(stat($b))[9]<=>(stat($a))[9] || $a cmp $b} @files) {
    next if $visited{$source->{name}."\0".$path}++ || !-f $path || -l $path;
    my $real=realpath($path)//next; next unless index($real,"$realroot/")==0;
    last if ($source->{fileSelection}//"all") eq "latest" && $files;
    if (++$files>64 || !$budget) {$truncated=1; last SOURCE;}
    open my $file,"<:raw",$path or next;
    my $position=-s $file; my $pending=""; my $delimiter=$source->{recordEnd} eq "newline"?"\n":encode("UTF-8",$source->{recordEnd});
    if ($source->{ordered} && $source->{recordEnd} eq "newline") {
      my $located=end_position($file,$position,$source); $position=$located if defined $located;
    }
    my $finished=0;
    while ($position>0 && $budget>0) {
      my $length=$position<65536?$position:65536; $length=$budget if $length>$budget;
      $position-=$length; seek($file,$position,0); read($file,my $chunk,$length); $budget-=$length;
      my @records=split(/\Q$delimiter\E/,$chunk.$pending,-1); $pending=$position?shift(@records):"";
      for my $record(reverse @records) {
        next unless length $record;
        if ($source->{ordered}) {my $stamp=record_stamp($record,$source); if (defined($stamp) && $stamp lt $start) {$finished=1;last;}}
        record_row($record,$source,substr($path,length($root)+1));
      }
      last if $finished;
    }
    $truncated=1 if $position>0 && !$finished;
    close $file;
  }
}
push @rows,values %transactions if $kind eq "transaction";
my %map=(txnId=>"logId",txnNo=>"txnNo",business=>"business",service=>"service",node=>"node",messageCode=>"messageCode",messageInfo=>"messageInfo",level=>"level");
@rows=grep {
  my $row=$_; my $ok=1;
  for my $filter(keys %map) {my $needle=$query->{$filter}//""; $ok=0 if length($needle) && index(lc($row->{values}{$map{$filter}}//""),lc($needle))<0;}
  $ok=0 if length($query->{keyword}//"") && index(lc($row->{raw}),lc($query->{keyword}))<0;
  $ok=0 if length($query->{file}//"") && index(lc($row->{file}),lc($query->{file}))<0;
  $ok=0 if ($query->{minDurationMs}//0)>($row->{values}{duration}//0);
  if ($kind eq "transaction" && ($query->{status}//"ALL") ne "ALL") {my $code=$row->{values}{messageCode}//""; my $re=eval{qr/$row->{successPattern}/}; my $success=$re && $code=~$re; $ok=0 unless length($code) && (($query->{status} eq "SUCCESS")?$success:!$success);}
  $ok;
} @rows;
@rows=sort {$b->{values}{timestamp} cmp $a->{values}{timestamp} || $a->{file} cmp $b->{file} || $a->{raw} cmp $b->{raw}} @rows;
if (@rows>$limit) {splice @rows,$limit; $truncated=1 if $kind eq "detail";}
my $output_budget=16*1024*1024;
for my $row(@rows) {
  # Transaction tables consume mapped fields only. Do not transmit duplicate
  # context/message payloads; filtering above still sees the original record.
  if ($kind eq "transaction") {delete $row->{values}{message}; $row->{raw}="";}
  $row->{values}{message}=substr($row->{values}{message}//"",0,4096);
  my $raw_limit=$kind eq "detail"?65536:4096;
  $truncated=1 if $kind eq "detail" && length($row->{raw})>$raw_limit;
  $row->{raw}=substr($row->{raw},0,$raw_limit);
  my $encoded=encode_json($row);
  if (length($encoded)>$output_budget) {$truncated=1;last;}
  $output_budget-=length($encoded); print "\@OPSLOG_ROW\t",$encoded,"\n";
}
print encode("UTF-8","\@OPSLOG_SCAN_LIMIT\t声明式规则采集或输出已达到安全上限，结果可能不完整\n") if $truncated;
' "$root" "$days" "$start" "$end" "$limit" "$kind" "$rules" "$filters"
