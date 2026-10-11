"""Unit test for trimming transparent margins; imports main but never connects to the database."""
import io, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from PIL import Image
import main


def webp(im, **kw):
    b = io.BytesIO(); im.save(b, "WEBP", **kw); return b.getvalue()


def test_transparent_margin_is_trimmed_but_not_the_figure():
    im = Image.new("RGBA", (800, 800), (0, 0, 0, 0))
    im.paste((200, 30, 30, 255), (200, 100, 600, 700))          # 400x600 figure
    out = Image.open(io.BytesIO(main.convert_to_webp(webp(im, lossless=True))))
    assert out.width < 440 and out.height < 640, out.size       # margin gone (keeps a small breathing room)
    assert out.width >= 400 and out.height >= 600, out.size     # figure intact


def test_opaque_photo_is_left_alone():
    im = Image.new("RGB", (800, 800), (255, 255, 255)); im.paste((10, 10, 10), (300, 300, 500, 500))
    out = Image.open(io.BytesIO(main.convert_to_webp(webp(im, lossless=True))))
    assert out.size == (800, 800), out.size


def test_first_photo_id_takes_only_the_first_of_a_list():
    assert main.first_photo_id("AAA,BBB,CCC") == "AAA"
    assert main.first_photo_id(" AAA , BBB") == "AAA"
    assert main.first_photo_id("AAA") == "AAA"
    assert main.first_photo_id("") == "" and main.first_photo_id(None) == ""
