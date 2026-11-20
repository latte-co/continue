"""Windows transport shim for the existing deterministic native-wire fixtures.

No model calls. Preserve the original peers' protocol assertions; adapt only
the OpenCode Unix test socket to its native Windows named pipe.
"""
import io
import json
import os
from pathlib import Path
import runpy
import socket
import sys
import uuid
import threading
import traceback

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
agent = Path(__file__).parent.name
invocation = Path(os.environ["LATTE_RUNTIME_NATIVE_ROOT"]) / "invocations" / (str(uuid.uuid4()) + ".json")
invocation.write_text(json.dumps({"agent": agent, "pid": os.getpid(), "args": sys.argv[1:], "cwd": os.getcwd()}), encoding="utf-8")


def thread_error(args):
    with (Path(os.environ["LATTE_RUNTIME_NATIVE_ROOT"]) / "fixture-errors.log").open("a", encoding="utf-8") as errors:
        traceback.print_exception(args.exc_type, args.exc_value, args.exc_traceback, file=errors)

threading.excepthook = thread_error


class PrivatePipe:
    def __enter__(self):
        return self

    def __exit__(self, *_):
        if hasattr(self, "file"):
            self.file.close()

    def connect(self, address):
        assert address.startswith("\\\\.\\pipe\\latte-work-"), address
        self.file = open(address, "r+b", buffering=0)

    def makefile(self, mode):
        assert mode == "rw"
        return io.TextIOWrapper(io.BufferedRWPair(self.file, self.file), encoding="utf-8", newline="\n", line_buffering=True)


original_socket = socket.socket
if agent == "opencode":
    if not hasattr(socket, "AF_UNIX"):
        socket.AF_UNIX = -1  # Local fixture sentinel; the actual transport is PrivatePipe.
    socket.socket = lambda family, *args, **kwargs: PrivatePipe() if family == socket.AF_UNIX else original_socket(family, *args, **kwargs)

fixture = Path(os.environ["LATTE_RUNTIME_NATIVE_FIXTURES"]) / (agent + ".py")
sys.argv[0] = str(fixture)
try:
    runpy.run_path(str(fixture), run_name="__main__")
except Exception:
    import traceback
    with (Path(os.environ["LATTE_RUNTIME_NATIVE_ROOT"]) / "fixture-errors.log").open("a", encoding="utf-8") as errors:
        traceback.print_exc(file=errors)
    raise
