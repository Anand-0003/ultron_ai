#!/usr/bin/env python3
"""Runs a login shell on a pseudo-terminal for ULTRON's built-in terminal.

stdin  -> keystrokes for the shell        stdout <- everything the shell prints
fd 3   -> "rows cols\n" whenever the terminal is resized
stderr <- one line, the shell's pid (the server uses it to follow the shell's folder)
The shell is hung up when stdin closes.
"""
import fcntl, os, pty, select, signal, struct, sys, termios

pid, fd = pty.fork()
if pid == 0:
    shell = os.environ.get("SHELL") or "/bin/zsh"
    os.execvp(shell, [shell, "-l"])

sys.stderr.write("%d\n" % pid)
sys.stderr.flush()


def write_all(target, data):
    while data:
        data = data[os.write(target, data):]


watch, pending = [fd, 0, 3], b""
try:
    while True:
        try:
            ready, _, _ = select.select(watch, [], [])
        except InterruptedError:
            continue
        if fd in ready:
            try:
                out = os.read(fd, 65536)
            except OSError:
                break
            if not out:
                break
            write_all(1, out)
        if 0 in ready:
            keys = os.read(0, 65536)
            if not keys:
                break
            write_all(fd, keys)
        if 3 in ready:
            chunk = os.read(3, 1024)
            if not chunk:
                watch.remove(3)
                continue
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                try:
                    rows, cols = (max(1, min(1000, int(n))) for n in line.split())
                    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                except (ValueError, OSError):
                    pass
except (BrokenPipeError, KeyboardInterrupt):
    pass
finally:
    try:
        os.kill(pid, signal.SIGHUP)
    except OSError:
        pass
