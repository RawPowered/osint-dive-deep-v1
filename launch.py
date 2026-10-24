"""Cross-platform local research studio launcher (Python 3.12+)."""
from pathlib import Path
import hashlib
import os
import subprocess
import sys
import venv

ROOT = Path(__file__).resolve().parent


def main():
    if sys.version_info < (3, 12):
        raise SystemExit("Install Python 3.12 or newer first.")
    environment = ROOT / ".venv"
    binary = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not binary.exists():
        venv.EnvBuilder(with_pip=True).create(environment)
    requirements = ROOT / "studio/requirements.txt"
    expected = hashlib.sha256(requirements.read_bytes()).hexdigest()
    stamp = environment / ".divedeep-requirements"
    if not stamp.exists() or stamp.read_text() != expected or "--install" in sys.argv:
        subprocess.check_call([str(binary), "-m", "pip", "install", "-r", str(requirements)])
        stamp.write_text(expected)
    environment_values = os.environ.copy()
    environment_values["PATH"] = str(binary.parent) + os.pathsep + environment_values.get("PATH", "")
    environment_values["STREAMLIT_BROWSER_GATHER_USAGE_STATS"] = "false"
    # Local-only by default. Deployments use the authenticated API and reverse proxy.
    return subprocess.call([
        str(binary), "-m", "streamlit", "run", str(ROOT / "studio/app.py"),
        "--server.address=127.0.0.1", "--server.port=8501", "--server.headless=true",
    ], cwd=ROOT / "studio", env=environment_values)


if __name__ == "__main__":
    raise SystemExit(main())
