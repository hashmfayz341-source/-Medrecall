"""Synthetic but distinct 'photographs' for the benchmark decks (PIL only)."""
import random, os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "img")

def histology(name, seed, base=(236, 196, 214), nuclei=(92, 48, 140), density=260, big=False, size=(640, 480), extra=None):
    r = random.Random(seed)
    im = Image.new("RGB", size, base)
    d = ImageDraw.Draw(im)
    # stromal fibres
    for _ in range(40):
        x, y = r.randrange(size[0]), r.randrange(size[1])
        col = tuple(max(0, min(255, c + r.randint(-40, 20))) for c in base)
        d.line([(x, y), (x + r.randint(-200, 200), y + r.randint(-120, 120))], fill=col, width=r.randint(3, 12))
    # structures
    if extra:
        extra(d, r, size)
    for _ in range(density):
        x, y = r.randrange(size[0]), r.randrange(size[1])
        rad = r.randint(3, 11 if big else 6)
        col = tuple(max(0, min(255, c + r.randint(-30, 30))) for c in nuclei)
        d.ellipse([x - rad, y - rad, x + rad, y + rad], fill=col)
    im = im.filter(ImageFilter.GaussianBlur(1.2))
    im.save(os.path.join(OUT, name), quality=90)

def gross(name, seed, body, bg=(40, 60, 70), shape="foot", size=(640, 480)):
    r = random.Random(seed)
    im = Image.new("RGB", size, bg)
    d = ImageDraw.Draw(im)
    for _ in range(300):
        x, y = r.randrange(size[0]), r.randrange(size[1])
        d.point((x, y), fill=tuple(min(255, c + r.randint(0, 30)) for c in bg))
    if shape == "foot":
        d.ellipse([120, 120, 520, 400], fill=(214, 170, 150))
        for i in range(5):
            d.ellipse([430 + i * 8, 110 + i * 60, 560 + i * 8, 170 + i * 60], fill=body[i % len(body)])
        d.polygon([(380, 120), (560, 100), (600, 420), (380, 400)], fill=body[0])
    elif shape == "organ":
        d.ellipse([80, 80, 560, 420], fill=body[0])
        for _ in range(140):
            x, y = r.randint(120, 520), r.randint(110, 390)
            rad = r.randint(6, 22)
            d.ellipse([x - rad, y - rad, x + rad, y + rad], fill=body[r.randrange(len(body))])
    elif shape == "lung":
        d.ellipse([60, 60, 300, 440], fill=body[0]); d.ellipse([340, 60, 580, 440], fill=body[0])
        for _ in range(200):
            x, y = r.randint(80, 560), r.randint(80, 420)
            d.ellipse([x - 5, y - 5, x + 5, y + 5], fill=body[r.randrange(len(body))])
    im = im.filter(ImageFilter.GaussianBlur(1.5))
    im.save(os.path.join(OUT, name), quality=90)

def logo(name):
    im = Image.new("RGB", (220, 220), (255, 255, 255))
    d = ImageDraw.Draw(im)
    d.ellipse([10, 10, 210, 210], fill=(20, 60, 140))
    d.rectangle([95, 50, 125, 170], fill=(255, 255, 255)); d.rectangle([50, 95, 170, 125], fill=(255, 255, 255))
    im.save(os.path.join(OUT, name))

def text_table(name):
    im = Image.new("RGB", (900, 520), (255, 255, 255))
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 26)
    rows = [("Type", "Protein", "Association"), ("Primary (AL)", "Light chains", "Plasma cell dyscrasia"),
            ("Secondary (AA)", "Serum amyloid A", "Chronic inflammation"), ("Senile", "Transthyretin", "Aging heart"),
            ("Dialysis", "β2-microglobulin", "Long-term dialysis")]
    for i, row in enumerate(rows):
        for j, cell in enumerate(row):
            d.text((20 + j * 300, 30 + i * 95), cell, fill=(0, 0, 0), font=f)
        d.line([(10, 20 + i * 95 + 80), (890, 20 + i * 95 + 80)], fill=(0, 0, 0), width=2)
    im.save(os.path.join(OUT, name))

def granuloma(d, r, size):
    cx, cy = size[0] // 2, size[1] // 2
    d.ellipse([cx - 210, cy - 170, cx + 210, cy + 170], fill=(240, 170, 200))
    d.ellipse([cx - 110, cy - 90, cx + 110, cy + 90], fill=(250, 225, 235))

def islet(d, r, size):
    d.ellipse([170, 110, 470, 370], fill=(250, 215, 225))

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    gross("wet_gangrene.jpg", 11, [(70, 90, 40), (90, 60, 50), (60, 80, 30)], shape="foot")
    gross("dry_gangrene.jpg", 12, [(15, 12, 10), (30, 25, 20), (8, 8, 8)], bg=(170, 170, 180), shape="foot")
    gross("wet_gangrene_b.jpg", 13, [(80, 100, 45), (100, 70, 50)], bg=(200, 210, 200), shape="foot")
    gross("dry_gangrene_b.jpg", 14, [(10, 10, 10), (40, 30, 25)], bg=(60, 40, 40), shape="foot")
    histology("papillary_ptc.jpg", 21, base=(240, 200, 220), nuclei=(150, 120, 190), density=500, big=True)
    histology("follicular_ftc.jpg", 22, base=(230, 150, 190), nuclei=(70, 30, 120), density=180)
    histology("t1dm_insulitis.jpg", 31, base=(235, 190, 210), nuclei=(50, 20, 110), density=700, extra=islet)
    histology("t2dm_amyloid.jpg", 32, base=(245, 215, 225), nuclei=(120, 80, 160), density=90, extra=islet)
    gross("normal_liver.jpg", 41, [(140, 50, 40)], bg=(30, 30, 30), shape="organ")
    gross("cirrhotic_liver.jpg", 42, [(170, 120, 50), (190, 150, 60), (120, 90, 40)], bg=(220, 220, 220), shape="organ")
    gross("left_hf_lung.jpg", 51, [(170, 80, 90), (120, 40, 50)], bg=(20, 20, 40), shape="lung")
    histology("right_hf_nutmeg.jpg", 52, base=(200, 140, 90), nuclei=(110, 40, 30), density=300)
    histology("tb_granuloma.jpg", 61, base=(236, 196, 214), nuclei=(80, 40, 130), density=350, extra=granuloma)
    text_table("amyloid_table.png")
    histology("thumb.jpg", 71, size=(60, 45), density=20)
    histology("acute_mi.jpg", 81, base=(230, 120, 150), nuclei=(40, 20, 120), density=600)
    histology("congo_red.jpg", 91, base=(250, 160, 150), nuclei=(160, 200, 90), density=120)
    histology("acute_appendicitis.jpg", 101, base=(235, 180, 205), nuclei=(40, 10, 90), density=800)
    histology("chronic_cholecystitis.jpg", 102, base=(225, 200, 215), nuclei=(60, 50, 130), density=260, big=True)
    histology("fatty_liver.jpg", 111, base=(245, 225, 230), nuclei=(90, 50, 140), density=200)
    logo("logo.png")
    print("ok")
