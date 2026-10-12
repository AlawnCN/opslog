set -eu
decode_arg() { if [ "$1" = "-" ]; then return 0; fi; printf '%s' "$1" | perl -pe 's/([0-9a-f]{2})/chr(hex($1))/ge'; }
root=$(decode_arg "$1"); days=$(decode_arg "$2"); start=$(decode_arg "$3"); end=$(decode_arg "$4")
limit=$(decode_arg "$5"); kind=$(decode_arg "$6"); rules=$(decode_arg "$7"); filters=$(decode_arg "$8")
perl -MEncode -MCwd=realpath -e '
use strict; use warnings; use utf8;
# OPSLOG_JSON_CODEC
# OPSLOG_CURSOR_PROTOCOL
my ($root,$days,$start,$end,$limit,$kind,$rules,$filters)=@ARGV;
my $sources=decode_json($rules); my $query=decode_json($filters); my $budget=8*1024*1024;
my $paging=$query->{_snapshotPaging};
my $saved=$query->{_scanCursors}{$query->{_scanServer}//""};
my $snapshot=$saved//{files=>{}, manifests=>{}};
$budget=64*1024*1024 if $paging;
my (%transactions,@rows,%visited,$truncated,%directories,$primary_transactions); my $entries=0; my $year=substr($start,0,4); my $end_year=substr($end,0,4);
my $realroot=realpath($root)//die "Invalid application directory";
$root=$realroot;
my %compiled_regex;
# Every textual field is extracted as a contiguous substring of the decoded
# record (trimming and async-ID suffix removal only shorten it). These literal
# checks are necessary, not sufficient: field-aware checks still run afterwards.
my %query_fields=(txnId=>"logId",txnNo=>"txnNo",business=>"business",service=>"service",node=>"node",messageCode=>"messageCode",messageInfo=>"messageInfo",level=>"level",traceId=>"traceId");
my @text_needles=map {lc($query->{$_})} grep {length($query->{$_}//"")} (keys %query_fields,"keyword");
die "Invalid source count" unless ref($sources) eq "ARRAY" && @$sources<=12;
for my $source (@$sources) {
  die "Invalid file selection" unless ($source->{fileSelection}//"all")=~/^(all|latest)$/;
  $source->{successPattern}//="00000\$"; $source->{stripAsyncSuffix}//=1;
  die "Invalid fields" unless ref($source->{fields}) eq "HASH" && $source->{fields}{timestamp};
  for my $mapping(values %{$source->{fields}}) {if (defined $mapping->{regex}) {die "Unsafe regex" if length($mapping->{regex})>500 || $mapping->{regex}=~/\(\?\??\s*\{/; $compiled_regex{$mapping->{regex}}=eval {qr/$mapping->{regex}/}; die "Invalid regex" if $@;}}
  die "Unsafe result regex" if length($source->{successPattern}//"")>200 || ($source->{successPattern}//"")=~/\(\?\??\s*\{/;
}
sub normalize_stamp {
  my ($stamp,$source)=@_; $stamp=~tr/,/./; $stamp=~s/T/ /; $stamp=~s/^\s+|\s+$//g;
  if ($source->{timestampStyle} eq "month-day") {my $short=$stamp; $stamp="$year-$short"; $stamp="$end_year-$short" if $year ne $end_year && ($stamp lt $start || $stamp ge $end);}
  return $stamp;
}
sub extract {
  my ($record,$parts,$mapping)=@_; return "" unless $mapping;
  if (defined $mapping->{regex}) { my $re=$compiled_regex{$mapping->{regex}}; return "" unless $re; return $1//"" if $record=~$re; return ""; }
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
  # Only snapshot summaries are filtered per record. Legacy transactionEvent
  # aggregation may combine fields from different records and must not prefilter.
  if ($paging && @text_needles) {
    my $text=lc($record);
    for my $needle (@text_needles) {return if index($text,$needle)<0;}
  }
  # Regex timestamps do not need field splitting. Reject out-of-range records
  # before the expensive JSON-aware delimiter scan, even for unordered files.
  # Index-based timestamps retain the original splitting path and semantics.
  my $early_stamp;
  if (defined $source->{fields}{timestamp}{regex}) {
    $early_stamp=normalize_stamp(extract($record,[],$source->{fields}{timestamp}),$source);
    return unless $early_stamp=~/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.]\d{3}$/;
    return if $early_stamp lt $start || $early_stamp ge $end;
  }
  my @parts=parts($record,$source->{delimiter}); my %values;
  for my $key (keys %{$source->{fields}}) {$values{$key}=extract($record,\@parts,$source->{fields}{$key}); $values{$key}=~s/^\s+|\s+$//g;}
  my $stamp=normalize_stamp($values{timestamp}//"",$source);
  return unless $stamp=~/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[.]\d{3}$/;
  return if $stamp lt $start || $stamp ge $end;
  $values{timestamp}=$stamp; $values{message}=$record unless length($values{message}//"");
  my $id=$values{logId}//""; $id=~s/-\d+$// if $source->{stripAsyncSuffix}; $values{logId}=$id;
  $truncated=1 if $kind eq "detail" && length($record)>65536;
  my $row={values=>\%values,file=>$path,raw=>substr($record,0,65536),successPattern=>$source->{successPattern},role=>$source->{role}};
  return if $paging && !matches_query($row);
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
sub matches_query {
  my ($row)=@_;
  for my $filter(keys %query_fields) {my $needle=$query->{$filter}//""; return 0 if length($needle) && index(lc($row->{values}{$query_fields{$filter}}//""),lc($needle))<0;}
  for my $filter ("keyword","file") {my $needle=$query->{$filter}//""; my $text=$filter eq "keyword"?$row->{raw}:$row->{file}; return 0 if length($needle) && index(lc($text),lc($needle))<0;}
  return 0 if ($query->{minDurationMs}//0)>($row->{values}{duration}//0);
  if (($query->{status}//"ALL") ne "ALL") {my $code=$row->{values}{messageCode}//""; my $re=qr/$row->{successPattern}/; my $success=$code=~$re; return 0 unless length($code) && (($query->{status} eq "SUCCESS")?$success:!$success);}
  return 1;
}
sub record_stamp {
  my ($record,$source)=@_;
  $record=decode("UTF-8",$record,Encode::FB_DEFAULT);
  my @parts=defined($source->{fields}{timestamp}{regex})?():parts($record,$source->{delimiter});
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
  next if $paging && $source->{fallbackOnly};
  next if $kind eq "transaction" && $source->{fallbackOnly} && $primary_transactions;
  next if $kind eq "transaction" && $source->{role}!~/^transaction/;
  next if $kind eq "detail" && $source->{role}!~/^(detail|transactionEvent)$/;
  next if $kind eq "application" && $source->{role} ne "application";
  next if $kind eq "ecp" && $source->{role} ne "ecp";
  my @files;
  if ($paging && $saved) {@files=@{$snapshot->{manifests}{$source->{name}}//[]};}
  else {
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
  }
  if ($paging && !$saved) {
    my %seen; @files=grep {!$seen{$_}++ && -f $_ && !-l $_} sort {(stat($b))[9]<=>(stat($a))[9] || $a cmp $b} @files;
    @files=($files[0]) if @files && ($source->{fileSelection}//"all") eq "latest";
    $snapshot->{manifests}{$source->{name}}=[@files];
  }
  my $files=0;
  for my $path(sort {(stat($b))[9]<=>(stat($a))[9] || $a cmp $b} @files) {
    die "SSH 查询快照文件已被删除或替换，请重新查询首页" if $paging && (!-f $path || -l $path);
    next if $visited{$source->{name}."\0".$path}++ || !-f $path || -l $path;
    my $real=realpath($path)//next; next unless index($real,"$realroot/")==0;
    last if ($source->{fileSelection}//"all") eq "latest" && $files;
    if (++$files>64 || !$budget) {$truncated=1; last SOURCE;}
    open my $file,"<:raw",$path or do {die "无法读取查询快照文件，请检查权限后重新查询首页" if $paging; next;};
    my $position=-s $file; my $pending=""; my $delimiter=$source->{recordEnd} eq "newline"?"\n":encode("UTF-8",$source->{recordEnd});
    my $file_key=$source->{name}."\0".$path;
    my $state=$snapshot->{files}{$file_key};
    if ($paging) {
      my @stat=stat($file);
      if ($state) {
        die "SSH 查询快照文件已轮转或截断，请重新查询首页" if $state->{device}!=$stat[0] || $state->{inode}!=$stat[1] || $stat[7]<$state->{size};
        seek($file,$state->{markAt},0); read($file,my $mark,64);
        die "SSH 查询快照文件已改写，请重新查询首页" if unpack("H*",substr($mark,0,$state->{markLength})) ne $state->{mark};
        $position=$state->{position};
      } else {
        my $tail_size=$position<65536?$position:65536; seek($file,$position-$tail_size,0); read($file,my $tail,$tail_size);
        my $newline=rindex($tail,"\n"); die "汇总日志记录过长，无法建立查询快照" if $position && $newline<0;
        $position=$position-$tail_size+$newline+1 if $position;
        my $at=$position>64?$position-64:0; seek($file,$at,0); read($file,my $mark,$position-$at);
        $state={device=>$stat[0],inode=>$stat[1],size=>$position,position=>$position,markAt=>$at,markLength=>length($mark),mark=>unpack("H*",$mark)};
        $snapshot->{files}{$file_key}=$state;
      }
    }
    if (!$paging && $source->{ordered} && $source->{recordEnd} eq "newline") {
      my $located=end_position($file,$position,$source); $position=$located if defined $located;
    }
    my $finished=0; my $matched=0; my $lower_margin=0; my $page_margin=0; my $boundary_stamp; my $stop_stamp;
    while ($position>0 && $budget>0) {
      my $length=$position<65536?$position:65536; $length=$budget if $length>$budget;
      $position-=$length; seek($file,$position,0); read($file,my $chunk,$length); $budget-=$length;
      my @records=split(/\Q$delimiter\E/,$chunk.$pending,-1); $pending=$position?shift(@records):"";
      my $at=$position+($position?length($pending)+length($delimiter):0); my @located;
      for my $record (@records) {push @located,[$record,$at]; $at+=length($record)+length($delimiter);}
      for my $located(reverse @located) {
        my ($record,$record_at)=@$located;
        next unless length $record;
        my $stamp=($paging || $source->{ordered})?record_stamp($record,$source):undef;
        if ($paging) {
          # Finish the entire timestamp group at the lookback boundary. Otherwise
          # later batches could reorder equal-time rows already in the buffer.
          if (defined($stop_stamp) && defined($stamp) && $stamp lt $stop_stamp) {
            $state->{position}=$record_at+length($record)+length($delimiter); $finished=1;last;
          }
          $state->{position}=$record_at;
          if (defined($stamp) && $stamp ge $start) {$lower_margin=0;}
          elsif ($lower_margin || (defined($stamp) && $stamp lt $start)) {$lower_margin++;}
          if ($lower_margin>64) {$finished=1;$state->{position}=0;last;}
        } elsif ($source->{ordered} && defined($stamp) && $stamp lt $start) {$finished=1;last;}
        my $before=scalar @rows;
        record_row($record,$source,substr($path,length($root)+1));
        if ($paging) {
          $matched+=scalar(@rows)-$before;
          $boundary_stamp=$stamp if $matched>=$limit && !defined($boundary_stamp);
          $page_margin++ if defined $boundary_stamp;
          $stop_stamp=$stamp if $page_margin>64 && defined($stamp) && $stamp lt $boundary_stamp && !defined($stop_stamp);
        }
      }
      last if $finished;
    }
    if ($paging) {
      $state->{matched}=($state->{matched}//0)+$matched;
      $state->{position}=0 if !$position && !$finished;
    }
    die "查询补读达到安全上限，请缩小时间范围或增加筛选条件后重新查询" if $paging && $position>0 && !$finished;
    $truncated=1 if !$paging && $position>0 && !$finished;
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
if (!$paging && @rows>$limit) {splice @rows,$limit; $truncated=1 if $kind eq "detail";}
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
die "查询快照达到输出安全上限，请重新查询并增加筛选条件" if $paging && $truncated;
print "\@OPSLOG_CURSOR\t",encode_json($snapshot),"\n" if $paging;
' "$root" "$days" "$start" "$end" "$limit" "$kind" "$rules" "$filters"
