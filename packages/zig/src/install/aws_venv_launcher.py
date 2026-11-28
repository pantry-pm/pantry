"""Prepare the mirrored AWS CLI venv without changing its entrypoint scripts."""

import errno
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory


venv = Path(__file__).resolve().parent.parent / "venv"
python = Path(sys.executable).resolve()
runtime = venv / "bin" / "python"
config = venv / "pyvenv.cfg"
expected_config = os.fsencode(
    f"home = {python.parent}\n"
    f"include-system-site-packages = false\n"
    f"executable = {python}\n"
)

try:
    config_matches = config.read_bytes() == expected_config
except FileNotFoundError:
    config_matches = False

try:
    runtime_matches = runtime.readlink() == python
except OSError as error:
    if error.errno not in (errno.ENOENT, errno.EINVAL):
        raise
    runtime_matches = False

if not config_matches or not runtime_matches:
    # Every repair publishes complete contents in a single rename. Concurrent
    # launchers resolving the same interpreter can publish in either order.
    with TemporaryDirectory(prefix=".pantry-venv-", dir=venv) as scratch:
        staged = Path(scratch)
        if not config_matches:
            staged_config = staged / "pyvenv.cfg"
            staged_config.write_bytes(expected_config)
            staged_config.replace(config)
        if not runtime_matches:
            staged_runtime = staged / "python"
            staged_runtime.symlink_to(python)
            staged_runtime.replace(runtime)

# Pass the entrypoint to Python explicitly. Its original build-time shebang
# can refer to a different installation, even after the venv is usable.
os.execv(runtime, [str(runtime), str(venv / "bin" / "aws"), *sys.argv[1:]])
