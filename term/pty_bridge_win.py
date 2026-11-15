"""Runs PowerShell on a Windows pseudo-console (ConPTY) for ULTRON's built-in terminal.

Same job as pty_bridge.py, with one difference: Windows can't pass the server an extra pipe,
so terminal resizes come in on stdin as  ESC ] ultron;resize;<rows>;<cols> BEL.

stdin  -> keystrokes for the shell (and resize markers)    stdout <- everything the shell prints
stderr <- one line, the shell's pid
Needs:  pip install pywinpty
"""
import codecs
import os
import re
import shutil
import sys
import threading

try:
    from winpty import PtyProcess
except ImportError:
    sys.stderr.write("0\n")
    sys.stderr.flush()
    msg = "\r\n  The terminal needs pywinpty:  py -m pip install pywinpty\r\n  Then reopen this view.\r\n"
    sys.stdout.buffer.write(msg.encode())
    sys.stdout.flush()
    sys.exit(1)

RESIZE = re.compile(r"\x1b\]ultron;resize;(\d+);(\d+)\x07")

shell = shutil.which("pwsh") or "powershell.exe"
proc = PtyProcess.spawn([shell, "-NoLogo"], cwd=os.path.expanduser("~"), dimensions=(30, 100), env=dict(os.environ))
sys.stderr.write("%d\n" % proc.pid)
sys.stderr.flush()

out = sys.stdout.buffer


def pump_output():
    while True:
        try:
            data = proc.read(65536)
        except EOFError:
            break
        except Exception:
            break
        if not data:
            if not proc.isalive():
                break
            continue
        try:
            out.write(data.encode("utf-8", "replace"))
            out.flush()
        except (BrokenPipeError, OSError):
            break
    os._exit(0)


threading.Thread(target=pump_output, daemon=True).start()

decoder = codecs.getincrementaldecoder("utf-8")("replace")
pending = ""
stdin = sys.stdin.buffer
try:
    while True:
        chunk = stdin.read1(65536) if hasattr(stdin, "read1") else stdin.read(1)
        if not chunk:
            break
        pending += decoder.decode(chunk)
        # Keep a partial marker for the next read.
        cut = pending.rfind("\x1b]")
        keep = ""
        if cut >= 0 and "\x07" not in pending[cut:]:
            pending, keep = pending[:cut], pending[cut:]
        for m in RESIZE.finditer(pending):
            try:
                proc.setwinsize(max(1, min(1000, int(m.group(1)))), max(1, min(1000, int(m.group(2)))))
            except Exception:
                pass
        text = RESIZE.sub("", pending)
        pending = keep
        if text:
            proc.write(text)
except (BrokenPipeError, KeyboardInterrupt, OSError):
    pass
finally:
    try:
        proc.terminate(force=True)
    except Exception:
        pass
