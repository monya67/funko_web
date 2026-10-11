"""Site copy rules the owner asked for."""
import glob, os, re

ROOT = os.path.join(os.path.dirname(__file__), "..", "static")


def _texts():
    for path in glob.glob(os.path.join(ROOT, "*.html")) + [os.path.join(ROOT, "app.js")]:
        yield os.path.basename(path), open(path, encoding="utf-8").read()


def test_storage_period_is_60_days_everywhere_never_90():
    bad = [name for name, t in _texts() if re.search(r"90\s*(дн|дней)|30\s*[–-]\s*90", t)]
    assert not bad, f"90-day storage wording still in: {bad}"
