"""Finite, task-owned PTY proof. Never reads or changes the caller's terminal."""
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

node, subject, key_hex = sys.argv[1:]
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
child = None
captured = bytearray()
deadline = time.monotonic() + 12


def resize(width, height):
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))
    if child is not None:
        os.kill(child.pid, signal.SIGWINCH)


def frames():
    text = captured.decode('utf-8', errors='replace').replace('\r\n', '\n')
    return [(int(w), int(h), frame) for frame, w, h in re.findall(
        r'\x1b\[H\x1b\[2J(.*?)\nM019_FRAME_END (\d+) (\d+)\n', text, re.S)]


def pump_until(predicate):
    while time.monotonic() < deadline:
        if predicate():
            return
        if select.select([master], [], [], min(0.05, max(0, deadline - time.monotonic())))[0]:
            try:
                captured.extend(os.read(master, 65536))
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
        if len(captured) > 2 * 1024 * 1024:
            raise RuntimeError('PTY output bound exceeded')
        if child.poll() is not None and not predicate():
            raise RuntimeError('PTY subject exited before the expected state')
    raise RuntimeError('PTY readiness deadline expired')


try:
    resize(80, 36)
    env = dict(os.environ, TERM='xterm-256color')
    env.pop('NO_COLOR', None)
    child = subprocess.Popen([node, subject], stdin=slave, stdout=slave, stderr=slave,
                             start_new_session=True, close_fds=True, env=env)
    pump_until(lambda: any(w == 80 and h == 36 for w, h, _ in frames()))
    raw = termios.tcgetattr(slave)
    raw_during_run = not (raw[3] & (termios.ICANON | termios.ECHO))
    os.write(master, b'\x1b[B' * 4)
    resize(20, 10)
    pump_until(lambda: any(w == 20 and h == 10 and 'Selected' in frame and 'Saved' in frame
                          for w, h, frame in frames()))
    resize(55, 24)
    pump_until(lambda: any(w == 55 and h == 24 for w, h, _ in frames()))
    os.write(master, bytes.fromhex(key_hex))
    pump_until(lambda: b'M019_RESULT ' in captured)
    child.wait(timeout=max(0.1, deadline - time.monotonic()))
    text = captured.decode('utf-8', errors='replace').replace('\r\n', '\n')
    result = json.loads(re.search(r'M019_RESULT ([^\n]+)', text).group(1))
    result.update(exitCode=child.returncode, rawDuringRun=raw_during_run,
                  termiosRestored=termios.tcgetattr(slave) == before,
                  alternateEntered='\x1b[?1049h' in text,
                  alternateLeft='\x1b[?1049l' in text,
                  cursorRestored='\x1b[?25h' in text,
                  frames=[dict(width=w, height=h, text=f) for w, h, f in frames()])
    try:
        os.killpg(child.pid, 0)
        result['ownedGroupAbsent'] = False
    except ProcessLookupError:
        result['ownedGroupAbsent'] = True
    print(json.dumps(result))
finally:
    # The group was created exclusively for this child; no unrelated PID is targeted.
    if child is not None:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=3)
    os.close(master)
    os.close(slave)
