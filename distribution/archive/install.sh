#!/bin/sh
# Archive-first prototype. Uses only macOS system tools before the bundled Node.
set -eu
exec /usr/bin/perl - "$@" <<'PERL'
use strict;
use warnings;
use Cwd qw(realpath);
use Digest::SHA;
use Fcntl qw(:DEFAULT);
use File::Path qw(remove_tree);
use File::Temp qw(tempdir);
use IO::Uncompress::Gunzip qw($GunzipError);
use JSON::PP;
use POSIX qw(WNOHANG);
use Errno qw(ESRCH);
use Time::HiRes qw(clock_gettime CLOCK_MONOTONIC sleep);

my $MAX_DOWNLOAD = 256 * 1024 * 1024;
my $MAX_EXPANDED = 1024 * 1024 * 1024;
my $MAX_MEMBER = 256 * 1024 * 1024;
my ($tmp, $tmp_inode, $child, $stage, $preserve) = ('', 0, 0, 'arguments', 0);
my %opt;
sub fail { die "$_[0]\n"; }
sub now { clock_gettime(CLOCK_MONOTONIC) }
$SIG{INT} = $SIG{TERM} = $SIG{HUP} = sub { fail('Interrupted during '.$stage.'.'); };
$SIG{ALRM} = sub { fail(ucfirst($stage).' deadline exceeded.'); };

sub options {
    while (@ARGV) {
        my $flag = shift @ARGV;
        if ($flag eq '--help' && !@ARGV && !%opt) {
            print "Usage: install.sh --version VERSION --url HTTPS_URL --sha256 TRUSTED_SHA256 --home ABSOLUTE_TARGET [--no-path]\n";
            exit 0;
        }
        fail('Invalid or duplicate argument; use --help.') if exists $opt{$flag};
        if ($flag eq '--no-path' || $flag eq '--test-loopback-http') { $opt{$flag} = 1; next; }
        fail('Invalid argument; use --help.') unless $flag =~ /\A--(?:version|url|sha256|home)\z/ && @ARGV;
        $opt{$flag} = shift @ARGV;
    }
    for ('--version', '--url', '--sha256', '--home') { fail('Required argument missing; use --help.') unless defined $opt{$_} && length $opt{$_}; }
    fail('Invalid exact version.') unless $opt{'--version'} =~ /\A[0-9]+\.[0-9]+\.[0-9]+(?:-beta\.[0-9]+)?\z/ && length($opt{'--version'}) <= 64;
    fail('Invalid SHA256; supply 64 hexadecimal characters from a trusted source.') unless $opt{'--sha256'} =~ /\A[0-9a-fA-F]{64}\z/;
    $opt{'--sha256'} = lc $opt{'--sha256'};
    fail('Target home must be an absolute path without control characters.') unless $opt{'--home'} =~ m{\A/} && $opt{'--home'} !~ /[\x00-\x1f\x7f]/;
}

# A deliberately narrow URL grammar. No credentials, fragments, curl globbing,
# encoded authority or implicit hostnames. Validate EVERY redirect before curl.
sub url_parts {
    my ($url) = @_;
    fail('Invalid URL; use an explicit HTTPS URL without credentials or fragments.') if length($url) > 8192 || $url =~ /[^\x21-\x7e]|[\\#]/;
    my ($scheme, $authority, $rest) = $url =~ m{\A(https?)://([^/?]+)([/?].*)?\z};
    fail('Invalid URL; HTTPS is required.') unless defined $scheme;
    my ($host, $port) = $authority =~ /\A(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?\z/;
    fail('Invalid URL authority; credentials are not accepted.') unless defined $host && (!defined($port) || $port > 0 && $port <= 65535);
    fail('HTTPS is required; HTTP test mode permits only literal loopback addresses.') if $scheme ne 'https' && (!$opt{'--test-loopback-http'} || $host ne '127.0.0.1' && $host ne '[::1]');
    $rest = '/' unless defined($rest);
    $rest = '/'.$rest if $rest =~ /\A\?/;
    return ($scheme, $authority, $rest);
}
sub redirect_url {
    my ($base, $next) = @_;
    my ($scheme, $authority, $rest) = url_parts($base);
    my $url;
    if ($next =~ m{\A[a-zA-Z][a-zA-Z0-9+.-]*:}) { $url = $next; }
    elsif ($next =~ m{\A//}) { $url = $scheme.':'.$next; }
    elsif ($next =~ m{\A/}) { $url = "$scheme://$authority$next"; }
    else {
        $rest =~ s/\?.*//;
        if ($next =~ /\A\?/) { $url = "$scheme://$authority$rest$next"; }
        else { $rest =~ s{[^/]*\z}{}; $url = "$scheme://$authority$rest$next"; }
    }
    url_parts($url);
    return $url;
}
sub stop_curl {
    return unless $child;
    kill 'TERM', $child;
    for (1..50) { if (waitpid($child, WNOHANG) == $child) { $child = 0; return; } sleep 0.02; }
    kill 'KILL', $child;
    for (1..50) { if (waitpid($child, WNOHANG) == $child) { $child = 0; return; } sleep 0.02; }
    $preserve = 1;
}
sub download {
    my $url = $opt{'--url'};
    my $deadline = now() + 120;
    my ($total, $headers_total) = (0, 0);
    for my $redirect (0..3) {
        my ($scheme) = url_parts($url);
        my $remaining = $deadline - now();
        fail('Download deadline exceeded.') if $remaining <= 0;
        pipe(my $reader, my $writer) or fail('Cannot create download pipe.');
        $child = fork();
        fail('Cannot start download.') unless defined $child;
        if (!$child) {
            $SIG{INT} = $SIG{TERM} = $SIG{HUP} = $SIG{ALRM} = 'DEFAULT';
            close $reader;
            open STDIN, '<', '/dev/null' or POSIX::_exit(126);
            open STDOUT, '>&', $writer or POSIX::_exit(126);
            open STDERR, '>', '/dev/null' or POSIX::_exit(126);
            close $writer;
            # -q is first: never read ~/.curlrc. No proxy/netrc credentials or
            # automatic redirects. Raw curl errors may contain secret URLs.
            exec '/usr/bin/curl', '-q', '--silent', '--globoff', '--proxy', '',
                '--proto', '='.$scheme, '--max-time', sprintf('%.3f', $remaining),
                '--connect-timeout', '15', '--max-redirs', '0', '--include',
                '--http1.1', '--url', $url or POSIX::_exit(126);
        }
        close $writer;
        binmode $reader;
        open my $output, '>', "$tmp/archive.gz" or fail('Cannot create download file.');
        binmode $output;
        my ($pending, $status, $location, $reading_headers) = ('', 0, undef, 1);
        while (1) {
            fail('Download deadline exceeded.') if now() >= $deadline;
            my $n = sysread($reader, my $chunk, 65536);
            fail('Download read failed.') unless defined $n;
            last if !$n;
            if ($reading_headers) {
                $pending .= $chunk;
                while ($reading_headers && $pending =~ /\r\n\r\n/) {
                    my $end = index($pending, "\r\n\r\n") + 4;
                    my $block = substr($pending, 0, $end, '');
                    $headers_total += length $block;
                    fail('Download response headers exceed limit.') if $headers_total > 65536;
                    my @lines = split /\r\n/, $block;
                    my $first = shift @lines;
                    ($status) = $first =~ /\AHTTP\/1\.[01] ([0-9]{3})(?: |\z)/;
                    fail('Invalid download response.') unless $status;
                    next if $status >= 100 && $status < 200 && $status != 101;
                    $reading_headers = 0;
                    for my $line (@lines) {
                        if ($line =~ /\Alocation:\s*(.*?)\s*\z/i) {
                            fail('Invalid redirect response.') if defined $location;
                            $location = $1;
                        }
                    }
                }
                fail('Download response headers exceed limit.') if $reading_headers && length($pending) + $headers_total > 65536;
                next if $reading_headers;
                $chunk = $pending; $pending = '';
            }
            $total += length $chunk;
            fail('Download exceeds 256 MiB compressed-byte limit.') if $total > $MAX_DOWNLOAD;
            print {$output} $chunk or fail('Cannot write download file.') if $status == 200;
        }
        close $reader;
        close $output or fail('Cannot finish download file.');
        waitpid($child, 0);
        my $code = $?; $child = 0;
        fail('Download failed or was incomplete; check the selected URL and connection.') if $code || $reading_headers;
        if ($status == 200) { return; }
        fail('Download returned an unsuccessful HTTP status.') unless $status =~ /\A(?:301|302|303|307|308)\z/ && defined $location && length $location;
        fail('Download redirect limit exceeded (maximum three).') if $redirect == 3;
        $url = redirect_url($url, $location);
    }
}
sub tar_text {
    my ($value) = @_;
    fail('Invalid archive path encoding.') unless $value =~ /\A([^\x00]*)(\x00*)\z/s;
    $value = $1;
    fail('Invalid archive path text.') if $value =~ /[^\x20-\x7e]|\\/;
    return $value;
}
sub octal {
    my ($value) = @_;
    fail('Invalid archive numeric field.') unless $value =~ /\A[0-7]+\x00 ?\z/;
    return oct($value);
}
sub extract_archive {
    my $stem = 'mosaic-beta-'.$opt{'--version'}.'-darwin-arm64';
    open my $archive, '<', "$tmp/archive.gz" or fail('Cannot read archive.');
    binmode $archive;
    # The canonical builder emits a fixed ten-byte gzip header with no optional
    # name/comment/extra metadata. Reject extensions BEFORE a library can read
    # their unbounded NUL-terminated fields.
    my $gzip_header;
    read($archive, $gzip_header, 10) == 10 && substr($gzip_header,0,4) eq "\x1f\x8b\x08\x00"
        or fail('Invalid or noncanonical gzip archive header.');
    seek($archive,0,0) or fail('Cannot rewind archive.');
    my $gz = IO::Uncompress::Gunzip->new($archive, Transparent => 0, Strict => 1, MultiStream => 0)
        or fail('Invalid gzip archive.');
    my ($expanded, $members) = (0, 0);
    my %seen;
    my $read = sub {
        my ($length) = @_;
        my $bytes = '';
        while (length($bytes) < $length) {
            my $n = $gz->read(my $chunk, $length - length($bytes));
            fail('Invalid or truncated gzip archive.') unless defined($n) && $n > 0;
            $expanded += $n;
            fail('Archive exceeds 1 GiB expanded-byte limit.') if $expanded > $MAX_EXPANDED;
            $bytes .= $chunk;
        }
        return $bytes;
    };
    mkdir "$tmp/extracted", 0700 or fail('Cannot create archive staging.');
    while (1) {
        my $h = $read->(512);
        if ($h eq "\0" x 512) {
            fail('Invalid archive end marker.') unless $read->(512) eq "\0" x 512;
            # Canonical builder has exactly two zero blocks, with no trailing
            # tar payload, extra gzip member, or unbounded padding to inspect.
            my $n = $gz->read(my $extra, 1);
            fail('Invalid archive trailing data or gzip checksum.') unless defined($n) && $n == 0;
            fail('Invalid archive trailing gzip data.') if length($gz->trailingData());
            fail('Invalid archive trailing gzip data.') unless read($archive,my $tail,1) == 0;
            last;
        }
        fail('Archive member count exceeds 20000.') if ++$members > 20000;
        fail('Archive must use canonical ustar headers.') unless substr($h,257,8) eq "ustar\00000";
        my $check = substr($h,148,8);
        fail('Invalid archive header checksum.') unless $check =~ /\A[0-7]{6}\0 \z/;
        substr($h,148,8) = ' ' x 8;
        fail('Invalid archive header checksum.') unless unpack('%32C*',$h) == oct($check);
        my $name = tar_text(substr($h,0,100));
        my $prefix = tar_text(substr($h,345,155));
        $name = "$prefix/$name" if length $prefix;
        my $type = substr($h,156,1);
        fail('Unsafe archive member type; only regular files and directories are accepted.') unless $type eq '0' || $type eq '5';
        fail('Unsafe archive link metadata.') unless substr($h,157,100) eq "\0" x 100;
        $name =~ s{/\z}{} if $type eq '5';
        my @parts = split m{/}, $name, -1;
        fail('Unsafe archive path or wrong version/platform root.') if @parts > 64 || grep { $_ eq '' || $_ eq '.' || $_ eq '..' } @parts;
        fail('Wrong archive version/platform root.') unless $parts[0] eq $stem;
        fail('Duplicate archive path.') if exists $seen{$name};
        fail('Archive root must be a directory.') if @parts == 1 && $type ne '5';
        if (@parts > 1) { my @parent = @parts; pop @parent; fail('Archive parent is missing or not a directory.') unless ($seen{join('/',@parent)} // '') eq '5'; }
        my $size = octal(substr($h,124,12));
        my $mode = octal(substr($h,100,8));
        fail('Unsafe archive mode.') unless $type eq '5' ? ($mode == 0700 || $mode == 0755) : ($mode == 0600 || $mode == 0644 || $mode == 0755);
        fail('Archive member exceeds 256 MiB.') if $size > $MAX_MEMBER;
        fail('Archive directory has a nonzero size.') if $type eq '5' && $size;
        fail('Archive exceeds 1 GiB expanded-byte limit.') if $expanded + $size + (($size % 512) ? 512 - $size % 512 : 0) > $MAX_EXPANDED;
        fail('Archive metadata exceeds bounded read limit.') if ($name eq "$stem/payload/package-manifest.json" && $size > 2*1024*1024) || ($name eq "$stem/install" && $size > 65536) || ($name eq "$stem/verify.sha256" && $size > 4*1024*1024);
        my $target = "$tmp/extracted/$name";
        if ($type eq '5') { mkdir $target, 0700 or fail('Cannot create archive directory.'); }
        else {
            sysopen(my $file, $target, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0600) or fail('Cannot create archive member.');
            binmode $file;
            my $left = $size;
            while ($left) { my $length = $left > 65536 ? 65536 : $left; print {$file} $read->($length) or fail('Cannot extract archive member.'); $left -= $length; }
            close $file or fail('Cannot finish archive member.');
            chmod $mode, $target or fail('Cannot set archive member mode.');
            $read->(512 - $size % 512) if $size % 512;
        }
        $seen{$name} = $type;
    }
    $gz->close or fail('Invalid gzip archive checksum.');
    fail('Archive is missing its original installer or manifest.') unless ($seen{"$stem/install"} // '') eq '0' && ($seen{"$stem/payload/package-manifest.json"} // '') eq '0' && -x "$tmp/extracted/$stem/install";
    open my $file, '<', "$tmp/extracted/$stem/payload/package-manifest.json" or fail('Cannot read archive manifest.');
    local $/; my $bytes = <$file>; close $file;
    my $manifest = eval { JSON::PP->new->utf8->max_depth(64)->decode($bytes) };
    fail('Invalid archive manifest version or layout.') unless ref($manifest) eq 'HASH' && !ref($manifest->{schema}) && ($manifest->{schema} // '') eq '1' && !ref($manifest->{version}) && ($manifest->{version} // '') eq $opt{'--version'} && !ref($manifest->{layout}) && ($manifest->{layout} // '') =~ /\Aterminal-beta-v[12]\z/;
    return "$tmp/extracted/$stem/install";
}

my $ok = eval {
    umask 0077;
    options();
    url_parts($opt{'--url'});
    my $system = `/usr/bin/uname -s`; my $machine = `/usr/bin/uname -m`;
    fail('Platform requires Darwin arm64 and a native Apple Silicon terminal.') unless $system eq "Darwin\n" && $machine eq "arm64\n";
    $tmp = realpath(tempdir('mosaic-archive-XXXXXXXX', TMPDIR => 1, CLEANUP => 0));
    fail('Cannot create private download staging.') unless $tmp;
    $tmp_inode = (lstat($tmp))[1];
    $stage = 'download'; alarm 120;
    download();
    open my $file, '<', "$tmp/archive.gz" or fail('Cannot read downloaded bytes.'); binmode $file;
    my $sha = Digest::SHA->new(256)->addfile($file)->hexdigest; close $file;
    fail('SHA256 mismatch; no archive code was executed. Check your independently trusted digest.') unless $sha eq $opt{'--sha256'};
    alarm 0;
    $stage = 'archive inspection'; alarm 120;
    my $installer = extract_archive();
    alarm 0;
    # The original installer owns inventory/native validation, locks, recovery,
    # retained versions and the target. Do not reimplement maintenance here.
    $stage = 'installer';
    $child = fork(); fail('Cannot start original installer.') unless defined $child;
    if (!$child) {
        $SIG{INT} = $SIG{TERM} = $SIG{HUP} = $SIG{ALRM} = 'DEFAULT';
        POSIX::setpgid(0,0) == 0 or POSIX::_exit(126);
        exec $installer, '--home', $opt{'--home'}, ($opt{'--no-path'} ? ('--no-path') : ()) or POSIX::_exit(126);
    }
    my $group = $child;
    open my $owner, '>', "$tmp/installer-owner.txt" or fail('Cannot record installer ownership.');
    print {$owner} "pid=$child\nprocessGroup=$group\n"; close $owner;
    alarm 180;
    waitpid($child, 0) == $child or fail('Original installer ownership is unresolved.');
    my $code = $?; $child = 0; alarm 0;
    $! = 0;
    if (kill(0, -$group) || $! != ESRCH) {
        $preserve = 1;
        print STDERR "Mosaic download: installer process group $group is unresolved; staging preserved at $tmp.\n";
        fail('Original installer ownership is unresolved; observe quiescence before cleanup.');
    }
    fail('Original installer failed; inspect its target recovery state before retrying.') if $code;
    print "Mosaic download: verified selected archive and completed original installer.\n";
    1;
};
my $error = $@;
alarm 0;
$SIG{INT} = $SIG{TERM} = $SIG{HUP} = 'IGNORE';
if ($child && $stage eq 'installer') {
    # Installation can have durable transaction/descendant ownership. Do not
    # kill a possibly active maintenance tree or delete its staged runtime.
    $preserve = 1;
    print STDERR "Mosaic download: installer ownership unresolved (PID $child); staging preserved at $tmp. Inspect the target and wait for quiescence before cleanup.\n";
} elsif ($child) { stop_curl(); }
if ($tmp && !$preserve) {
    my @s = lstat($tmp);
    if (@s && -d _ && !-l _ && $s[1] == $tmp_inode && $s[4] == $<) {
        my $errors; remove_tree($tmp, {safe => 1, error => \$errors});
        if (@$errors) { print STDERR "Mosaic download: could not fully clean owned staging at $tmp.\n"; $ok = 0; }
    } else { print STDERR "Mosaic download: staging identity changed; preserve $tmp for inspection.\n"; $ok = 0; }
}
# All raised messages are fixed diagnostics, never curl/JSON/archive contents.
if (!$ok) { $error = 'Operation failed.' unless $error; print STDERR 'Mosaic download: '.$error; exit 1; }
exit 0;
PERL
