# Dependency-free JSON transport for bounded SSH scripts. No eval of input.
# Input is validated by the application; keep a depth and size limit remotely too.
sub decode_json {
  my $text=Encode::decode("UTF-8",shift,Encode::FB_CROAK);
  die "JSON input too large" if length($text)>1048576;
  my $position=0;
  my $space=sub { $position++ while substr($text,$position,1)=~/\s/; };
  my $string=sub {
    die "Expected JSON string" unless substr($text,$position++,1) eq "\"";
    my $result="";
    while ($position<length($text)) {
      my $char=substr($text,$position++,1);
      return $result if $char eq "\"";
      die "Invalid JSON control character" if ord($char)<32;
      if ($char ne "\\") {$result.=$char;next;}
      my $escape=substr($text,$position++,1);
      my %escapes=("\""=>"\"", "\\"=>"\\", "/"=>"/", "b"=>"\b", "f"=>"\f", "n"=>"\n", "r"=>"\r", "t"=>"\t");
      if (exists $escapes{$escape}) {$result.=$escapes{$escape};next;}
      die "Invalid JSON escape" unless $escape eq "u";
      my $hex=substr($text,$position,4); die "Invalid Unicode escape" unless $hex=~/^[0-9a-fA-F]{4}$/;
      $position+=4; my $code=hex($hex);
      if ($code>=0xd800 && $code<=0xdbff) {
        die "Missing low surrogate" unless substr($text,$position,2) eq "\\u";
        $position+=2; my $low=substr($text,$position,4);
        die "Invalid low surrogate" unless $low=~/^[0-9a-fA-F]{4}$/ && hex($low)>=0xdc00 && hex($low)<=0xdfff;
        $position+=4; $code=0x10000+(($code-0xd800)<<10)+(hex($low)-0xdc00);
      } elsif ($code>=0xdc00 && $code<=0xdfff) {die "Unexpected low surrogate";}
      $result.=chr($code);
    }
    die "Unclosed JSON string";
  };
  my $parse;
  $parse=sub {
    my $depth=shift; die "JSON nesting too deep" if $depth>40; $space->();
    my $char=substr($text,$position,1);
    return $string->() if $char eq "\"";
    if ($char eq "{" || $char eq "[") {
      $position++; my $object=$char eq "{"; my $close=$object?"}":"]"; my (%hash,@array);
      $space->();
      if (substr($text,$position,1) eq $close) {$position++;return $object?\%hash:\@array;}
      while (1) {
        $space->(); my $key;
        if ($object) {$key=$string->();$space->();die "Expected colon" unless substr($text,$position++,1) eq ":";}
        my $value=$parse->($depth+1);
        if ($object) {$hash{$key}=$value;} else {push @array,$value;}
        $space->();my $next=substr($text,$position++,1);
        return $object?\%hash:\@array if $next eq $close;
        die "Expected JSON separator" unless $next eq ",";
      }
    }
    for my $literal (qw(true false null)) {
      if (substr($text,$position,length($literal)) eq $literal) {$position+=length($literal);return $literal eq "null"?undef:$literal eq "true"?1:0;}
    }
    my $tail=substr($text,$position);
    if ($tail=~/\A(-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/) {$position+=length($1);return $1;}
    die "Invalid JSON value";
  };
  my $result=$parse->(0); $space->();die "Trailing JSON data" unless $position==length($text);
  return $result;
}
sub json_string {
  my $value=shift;
  $value=~s/([\\"\x00-\x1f])/sprintf("\\u%04x",ord($1))/ge;
  return "\"$value\"";
}
sub encode_json {
  my $encode;
  $encode=sub {
    my ($value,$depth)=@_;die "JSON nesting too deep" if $depth>40;
    return "null" unless defined $value;
    return "[".join(",",map {$encode->($_,$depth+1)} @$value)."]" if ref($value) eq "ARRAY";
    return "{".join(",",map {json_string($_).":".$encode->($value->{$_},$depth+1)} sort keys %$value)."}" if ref($value) eq "HASH";
    die "Unsupported JSON reference" if ref($value);
    # Log fields are strings, including numeric-looking IDs and duration values.
    return json_string($value);
  };
  return Encode::encode("UTF-8",$encode->(shift,0));
}
