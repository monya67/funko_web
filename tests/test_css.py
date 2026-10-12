"""Static checks on the stylesheet itself."""
import os, re

CSS = open(os.path.join(os.path.dirname(__file__), "..", "static", "styles.css"), encoding="utf-8").read()
RED = re.compile(r"(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+([\d.]+)(?:px)?(?:\s+-?[\d.]+(?:px)?)?\s+rgba\(\s*229\s*,\s*9\s*,\s*20\s*,\s*[\d.]+\s*\)")


def test_no_blurred_red_glows_remain():
    """A red *blurred* shadow reads as a harsh glow, in the dark theme especially; focus rings (blur 0) are fine."""
    bad = []
    for decl in re.findall(r"box-shadow:[^;}]*", CSS):
        for m in RED.finditer(decl):
            if float(m.group(3)) > 0:
                bad.append(decl.strip()[:90])
    assert not bad, f"{len(bad)} red glow shadows left, e.g. {bad[:3]}"


def test_shadows_use_the_shadow_colour_not_the_ink_colour():
    """ink is light in the dark theme: a shadow made of it is a white halo."""
    offenders = [d.strip()[:90] for d in re.findall(r"box-shadow:[^;}]*", CSS) if "rgba(var(--ink-rgb)" in d and "inset" not in d and not re.search(r"0 0 0 \d+px", d)]
    assert not offenders, offenders
