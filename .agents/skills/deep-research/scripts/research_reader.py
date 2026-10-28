#!/usr/bin/env python3
"""Bounded, public HTTPS reader. HTML and returned text are untrusted evidence.

read_url returns a JSON-serializable record. contentSha256 covers the decompressed
HTTP entity bytes, preserved as sourceBase64 or in sourcePath when artifact_dir is
supplied. No browsing, model calls, shell execution, cookies, or proxy support.
The underscored injection arguments exist for offline socket/DNS boundary tests;
they are deliberately absent from any command-line interface.
"""
import base64
import datetime
import hashlib
from html.parser import HTMLParser
import http.client
import io
import ipaddress
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import time
from urllib.parse import quote, urljoin, urlsplit, urlunsplit
import zlib

MAX_BYTES = 2 * 1024 * 1024
MAX_TEXT = 50000
MAX_TOTAL_SECONDS = 25.0
MAX_PARSER_SECONDS = 5.0
REDIRECT_CODES = {301, 302, 303, 307, 308}


class ReaderError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _remaining(deadline):
    value = deadline - time.monotonic()
    if value <= 0:
        raise ReaderError('timeout', 'The total reader deadline expired.')
    return value


def _public_ip(value):
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        raise ReaderError('unsafe_address', 'DNS returned an invalid address.')
    if (not address.is_global or address.is_multicast or address.is_reserved
            or address.is_unspecified or address.is_loopback or address.is_link_local
            or (address.version == 6 and (address.ipv4_mapped or address.sixtofour
                                          or address.teredo))):
        raise ReaderError('unsafe_address', 'Only ordinary public unicast addresses are permitted.')
    return address


def _validate_url(url):
    if not isinstance(url, str) or len(url) > 8192 or any(ord(c) <= 32 or ord(c) == 127 for c in url):
        raise ReaderError('unsafe_url', 'URL is empty, oversized, or contains whitespace/control characters.')
    try:
        parts = urlsplit(url)
        host = parts.hostname
        if (parts.scheme.lower() != 'https' or not host or parts.username is not None
                or parts.password is not None or parts.port not in (None, 443)):
            raise ValueError('Only credential-free HTTPS on port 443 is permitted.')
        if '%' in host or '\\' in parts.netloc:
            raise ValueError('Invalid hostname.')
        host = host.rstrip('.').encode('idna').decode('ascii').lower()
    except (ValueError, UnicodeError):
        raise ReaderError('unsafe_url', 'Only credential-free HTTPS URLs on port 443 are permitted.')
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal:
        _public_ip(str(literal))
    elif ('.' not in host or host.endswith(('.local', '.localhost', '.internal', '.home',
                                            '.lan', '.test', '.invalid', '.example'))
          or any(not label or len(label) > 63 or label[0] == '-' or label[-1] == '-'
                 or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in label)
                 for label in host.split('.'))):
        raise ReaderError('unsafe_url', 'Local and malformed hostnames are not permitted.')
    # Preserve encoded delimiters; quote non-ASCII path/query characters into an ASCII request target.
    path = quote(parts.path or '/', safe="/%:@!$&'()*+,;=-._~")
    query = quote(parts.query, safe="/%?:@!$&'()*+,;=-._~")
    authority = '[' + host + ']' if ':' in host else host
    normalized = urlunsplit(('https', authority, path, query, ''))
    target = path + ('?' + query if query else '')
    return normalized, host, authority, target, literal


def _child(operation, payload, timeout):
    completed = subprocess.run(
        [sys.executable, '-I', str(Path(__file__).resolve()), '--internal-child', operation],
        input=json.dumps(payload).encode('utf-8'), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=timeout, check=False,
    )
    if completed.returncode != 0 or len(completed.stdout) > 512 * 1024:
        raise ReaderError('parser_error' if operation == 'extract' else 'dns_error',
                          'The bounded child failed or exceeded its output limit.')
    try:
        result = json.loads(completed.stdout)
    except (ValueError, UnicodeError):
        raise ReaderError('parser_error' if operation == 'extract' else 'dns_error',
                          'The bounded child returned invalid data.')
    if 'error' in result:
        raise ReaderError(result['error']['code'], result['error']['message'])
    return result


def _resolve(host, timeout):
    try:
        return _child('dns', {'host': host}, timeout)['addresses']
    except subprocess.TimeoutExpired:
        raise ReaderError('timeout', 'DNS resolution exceeded the total reader deadline.')


class _WireReader(io.RawIOBase):
    """Counts all received HTTP bytes, including headers/chunk framing, with a shared deadline."""
    def __init__(self, sock, deadline):
        self.sock, self.deadline, self.received = sock, deadline, 0

    def readable(self):
        return True

    def readinto(self, buffer):
        self.sock.settimeout(_remaining(self.deadline))
        chunk = self.sock.recv(min(len(buffer), MAX_BYTES - self.received + 1))
        self.received += len(chunk)
        if self.received > MAX_BYTES:
            raise ReaderError('size_limit', 'The HTTP wire-byte limit was exceeded.')
        buffer[:len(chunk)] = chunk
        return len(chunk)


class _ResponseSocket:
    def __init__(self, sock, deadline):
        self.stream = io.BufferedReader(_WireReader(sock, deadline))

    def makefile(self, mode):
        return self.stream


def _request(host, authority, target, address, deadline, socket_factory, tls_context):
    family = socket.AF_INET6 if address.version == 6 else socket.AF_INET
    sock = socket_factory(family, socket.SOCK_STREAM, 0)
    wrapped = None
    try:
        sock.settimeout(_remaining(deadline))
        # Numeric address and an explicit family: this connect performs no further DNS lookup.
        sock.connect((str(address), 443, 0, 0) if address.version == 6 else (str(address), 443))
        if ipaddress.ip_address(sock.getpeername()[0]) != address:
            raise ReaderError('peer_mismatch', 'Connected peer differs from the vetted public address.')
        sock.settimeout(_remaining(deadline))
        wrapped = tls_context.wrap_socket(sock, server_hostname=host)
        if ipaddress.ip_address(wrapped.getpeername()[0]) != address:
            raise ReaderError('peer_mismatch', 'TLS peer differs from the vetted public address.')
        wrapped.settimeout(_remaining(deadline))
        request = ('GET ' + target + ' HTTP/1.1\r\nHost: ' + authority + '\r\n'
                   'User-Agent: FrontierResearchReader/1.0\r\n'
                   'Accept: text/html, application/xhtml+xml, text/plain\r\n'
                   'Accept-Encoding: gzip, deflate\r\nConnection: close\r\n\r\n')
        wrapped.sendall(request.encode('ascii'))
        response = http.client.HTTPResponse(_ResponseSocket(wrapped, deadline))
        try:
            response.begin()
            headers = response.headers
            status = response.status
            if status in REDIRECT_CODES:
                locations = headers.get_all('Location', [])
                if len(locations) != 1 or not locations[0]:
                    raise ReaderError('invalid_redirect', 'Redirect needs exactly one destination.')
                return {'status': status, 'location': locations[0]}
            if status in (401, 403):
                raise ReaderError('login_required' if status == 401 else 'access_denied',
                                  'The source requires login or denied public access.')
            if status == 429:
                raise ReaderError('rate_limited', 'The source rate-limited this request.')
            if status != 200:
                raise ReaderError('http_status', 'The source did not return HTTP 200.')
            lengths = headers.get_all('Content-Length', [])
            transfer = headers.get('Transfer-Encoding', '').lower().strip()
            if len(lengths) > 1 or (lengths and transfer) or transfer not in ('', 'chunked'):
                raise ReaderError('invalid_response', 'Ambiguous or unsupported HTTP framing.')
            if lengths:
                try:
                    length = int(lengths[0])
                except ValueError:
                    raise ReaderError('invalid_response', 'Invalid HTTP content length.')
                if length < 0:
                    raise ReaderError('invalid_response', 'Invalid HTTP content length.')
                if length > MAX_BYTES:
                    raise ReaderError('size_limit', 'The declared source exceeds the byte limit.')
            data = bytearray()
            while True:
                _remaining(deadline)
                chunk = response.read(65536)
                if not chunk:
                    if response.length not in (None, 0):
                        raise ReaderError('incomplete_response', 'The source body ended prematurely.')
                    break
                data.extend(chunk)
                if len(data) > MAX_BYTES:
                    raise ReaderError('size_limit', 'The source exceeds the byte limit.')
            return {'status': status, 'data': bytes(data), 'headers': headers}
        finally:
            response.close()
    finally:
        if wrapped is not None and wrapped is not sock:
            wrapped.close()
        sock.close()


def _decode_body(body, encoding):
    if encoding in ('', 'identity'):
        return body
    if encoding not in ('gzip', 'deflate'):
        raise ReaderError('unsupported_encoding', 'Only identity, gzip, and deflate encodings are supported.')
    try:
        decoder = zlib.decompressobj(16 + zlib.MAX_WBITS if encoding == 'gzip' else zlib.MAX_WBITS)
        decoded = decoder.decompress(body, MAX_BYTES + 1)
        if len(decoded) > MAX_BYTES or decoder.unconsumed_tail:
            raise ReaderError('size_limit', 'The decompressed source exceeds the byte limit.')
        if not decoder.eof or decoder.unused_data:
            raise ReaderError('invalid_compression', 'Incomplete or concatenated compression streams are unsupported.')
        return decoded
    except zlib.error:
        raise ReaderError('invalid_compression', 'The compressed source is malformed.')


def _persist_source(body, digest, artifact_dir):
    directory = Path(artifact_dir)
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / (digest + '.source')
    try:
        descriptor = os.open(str(destination), os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                             0o600)
    except FileExistsError:
        if destination.is_symlink() or destination.read_bytes() != body:
            raise ReaderError('artifact_error', 'Existing source artifact does not match its hash.')
    else:
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(body)
    return str(destination.resolve())


def read_url(url, *, artifact_dir=None, total_timeout=MAX_TOTAL_SECONDS,
             parser_timeout=MAX_PARSER_SECONDS, _resolver=None, _socket_factory=None,
             _tls_context=None, url_allowed=None):
    """Read one public source; errors are data and never contain extracted partial text.

    Limits may be reduced for callers/tests, but cannot be raised. Production DNS
    runs in a killable subprocess. Injected resolvers must honor their timeout.
    Source persistence paths are selected by the trusted caller, never by a page.
    """
    record = {'ok': False, 'url': url if isinstance(url, str) else None, 'finalUrl': None,
              'fetchedAt': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
              'contentSha256': None, 'text': '', 'truncated': False, 'extractedChars': 0,
              'redirects': [], 'sourceTrust': 'untrusted_public_content', 'error': None}
    try:
        total = min(float(total_timeout), MAX_TOTAL_SECONDS)
        parser_budget = min(float(parser_timeout), MAX_PARSER_SECONDS)
        if not (0 < total <= MAX_TOTAL_SECONDS and 0 < parser_budget <= MAX_PARSER_SECONDS):
            raise ReaderError('invalid_limit', 'Reader limits must be finite positive values.')
        deadline = time.monotonic() + total
        resolver = _resolver or _resolve
        socket_factory = _socket_factory or socket.socket
        tls_context = _tls_context or ssl.create_default_context()
        current = url
        for hop in range(4):
            normalized, host, authority, target, literal = _validate_url(current)
            if url_allowed is not None and not url_allowed(normalized):
                raise ReaderError('outside_scope', 'Redirect or source lies outside the approved domain scope.')
            record['finalUrl'] = normalized
            answers = [str(literal)] if literal is not None else resolver(host, _remaining(deadline))
            _remaining(deadline)
            if not answers or len(answers) > 64:
                raise ReaderError('dns_error', 'DNS must return between one and 64 addresses.')
            # Validate EVERY answer before opening ANY socket, including mixed v4/v6 responses.
            addresses = [_public_ip(value) for value in answers]
            result = _request(host, authority, target, addresses[0], deadline,
                              socket_factory, tls_context)
            record['status'] = result['status']
            if 'location' in result:
                if hop == 3:
                    raise ReaderError('too_many_redirects', 'At most three redirects are permitted.')
                destination = urljoin(normalized, result['location'])
                record['redirects'].append({'url': normalized, 'status': result['status'],
                                             'location': destination})
                current = destination
                continue
            headers = result['headers']
            mime = headers.get_content_type().lower()
            # Missing Content-Type must not inherit email.message's text/plain default.
            if not headers.get('Content-Type') or mime not in ('text/html', 'application/xhtml+xml', 'text/plain'):
                raise ReaderError('unsupported_format', 'Only explicit HTML or plain text responses are supported; PDF is unsupported.')
            body = _decode_body(result['data'], headers.get('Content-Encoding', '').lower().strip())
            if body.lstrip().startswith(b'%PDF-') or b'\x00' in body[:1024]:
                raise ReaderError('unsupported_format', 'PDF and binary source bodies are unsupported.')
            digest = hashlib.sha256(body).hexdigest()
            record.update(contentSha256=digest, sourceBytes=len(body), contentType=mime,
                          sourceRepresentation='decompressed_http_entity')
            if artifact_dir is None:
                record['sourceBase64'] = base64.b64encode(body).decode('ascii')
            else:
                record['sourcePath'] = _persist_source(body, digest, artifact_dir)
            _remaining(deadline)
            try:
                extracted = _child('extract', {'source': base64.b64encode(body).decode('ascii'),
                    'mime': mime, 'charset': headers.get_content_charset() or 'utf-8'},
                    min(parser_budget, _remaining(deadline)))
            except subprocess.TimeoutExpired:
                raise ReaderError('parser_timeout', 'Passive extraction exceeded its bounded deadline.')
            _remaining(deadline)
            record.update(ok=True, text=extracted['text'], truncated=extracted['truncated'],
                          extractedChars=extracted['extractedChars'], links=extracted.get('links',[]))
            return record
    except ReaderError as error:
        record['error'] = {'code': error.code, 'message': str(error)}
    except (socket.timeout, TimeoutError):
        record['error'] = {'code': 'timeout', 'message': 'The reader operation exceeded its deadline.'}
    except socket.gaierror:
        record['error'] = {'code': 'dns_error', 'message': 'Public DNS resolution failed.'}
    except ssl.SSLError:
        record['error'] = {'code': 'tls_error', 'message': 'TLS certificate validation or negotiation failed.'}
    except (http.client.HTTPException, ValueError, UnicodeError):
        record['error'] = {'code': 'invalid_response', 'message': 'The URL or HTTP response is malformed.'}
    except OSError:
        record['error'] = {'code': 'io_error', 'message': 'The source or artifact operation failed.'}
    return record


class _PageShape(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.password = False
        self.scripts = 0
        self.hidden_depth = 0
        self.visible = []
        self.links = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        href=values.get('href')
        if tag=='a' and isinstance(href,str) and len(href)<=1024 and len(self.links)<50:
            self.links.append(href)
        if tag == 'input' and values.get('type', '').lower() == 'password':
            self.password = True
        if tag == 'script':
            self.scripts += 1
        if tag in ('script', 'style', 'noscript'):
            self.hidden_depth += 1

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'noscript') and self.hidden_depth:
            self.hidden_depth -= 1

    def handle_data(self, data):
        if not self.hidden_depth:
            self.visible.append(data)


def _set_child_limits(operation):
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    # Darwin exposes RLIMIT_AS but rejects even a lower limit (ValueError).
    # CPU, file descriptor/file size, input/output, and wall limits remain enforced.
    if sys.platform != 'darwin' and hasattr(resource, 'RLIMIT_AS'):
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    if operation == 'extract':
        # Defense in depth: extraction cannot create sockets, even if a parser regresses.
        def no_network(*args, **kwargs):
            raise OSError('Networking is disabled in the passive extraction child.')
        class NoNetworkSocket(socket.socket):
            def __new__(cls, *args, **kwargs):
                raise OSError('Networking is disabled in the passive extraction child.')
        socket.socket = NoNetworkSocket
        socket.create_connection = no_network


def _extract(payload):
    source = base64.b64decode(payload['source'], validate=True)
    if len(source) > MAX_BYTES:
        raise ReaderError('size_limit', 'Extractor input exceeds the source limit.')
    try:
        content = source.decode(payload['charset'], errors='replace')
    except (LookupError, ValueError):
        raise ReaderError('unsupported_charset', 'The source declared an unsupported character encoding.')
    links=[]
    if payload['mime'] == 'text/plain':
        text = content
    else:
        shape = _PageShape()
        shape.feed(content)
        links=shape.links
        if shape.password:
            raise ReaderError('login_required', 'A password form prevents public evidence extraction.')
        visible = ' '.join(shape.visible).strip()
        if shape.scripts and (len(visible) < 40 or 'enable javascript' in visible.lower()):
            raise ReaderError('javascript_required', 'The page requires JavaScript rendering.')
        try:
            from importlib.metadata import version
            if version('trafilatura') != '2.3.1':
                raise ReaderError('dependency_error', 'Install the pinned trafilatura==2.3.1 requirement.')
            from trafilatura import extract
        except ImportError:
            raise ReaderError('dependency_error', 'Install the pinned trafilatura==2.3.1 requirement.')
        text = extract(content, include_comments=False, include_tables=True,
                       favor_precision=True) or ''
    if not text.strip():
        raise ReaderError('no_extractable_text', 'The public source has no extractable text.')
    return {'text': text[:MAX_TEXT], 'truncated': len(text) > MAX_TEXT, 'links':links,
            'extractedChars': len(text)}


def _child_main(operation):
    try:
        _set_child_limits(operation)
        payload = json.loads(sys.stdin.buffer.read(3 * MAX_BYTES))
        if operation == 'dns':
            addresses = sorted({item[4][0] for item in socket.getaddrinfo(
                payload['host'], 443, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM)})
            result = {'addresses': addresses}
        elif operation == 'extract':
            result = _extract(payload)
        else:
            raise ReaderError('invalid_operation', 'Unknown bounded child operation.')
    except ReaderError as error:
        result = {'error': {'code': error.code, 'message': str(error)}}
    except Exception:
        result = {'error': {'code': 'dns_error' if operation == 'dns' else 'parser_error',
                            'message': 'The bounded child could not process this input.'}}
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode('utf-8'))


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--internal-child' and sys.argv[2] in ('dns', 'extract'):
        _child_main(sys.argv[2])
    else:
        sys.stderr.write('This module exposes read_url() to trusted local callers; no fetch CLI is provided.\n')
        sys.exit(2)
