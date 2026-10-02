"""Create four explicit synthetic photos for local model/review acceptance.

These drawings test plumbing and readable text, not cultural identification
accuracy. Existing output is verified and reused; no user source is changed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

FIXTURE_VERSION = "artvenn-synthetic-photos/v1"
FONT_PATH = "/System/Library/Fonts/Supplemental/Songti.ttc"
LABEL_TEXT = "传张旭 书法 石刻（合成测试）"
# Generated independently from the checked fixture recipe with the pinned local
# Pillow/font combination. A user-editable adjacent manifest is not authority.
CERTIFIED_HASHES = {
    "01-overview.png": "91d80693c8f7c3af570efd09fd9cd0c8cfdd9aec0df763ff490004d192fa421c",
    "02-detail.png": "a027bcc7a586b1caadf8886cadf968a6e3bd03cf126cde582b02eee5cecf5b2c",
    "03-label.png": "1482a4eb92f529bbcbc594542896a94b2b22c10b34d6fd021f3dd57db84bbc2a",
    "04-different-object.png": "627fbd6899ad2a75ecb7054d2cffbeef9fa05220861456fc35e32d35c9da31a4",
}


def certified(source):
    import os
    source=Path(source)
    if not source.is_dir() or source.is_symlink():return False
    names=[]
    from daily import EXTENSIONS
    for directory,dirs,files in os.walk(source,followlinks=False):
        if any(Path(directory,d).is_symlink() for d in dirs):return False
        for name in files:
            path=Path(directory,name)
            if path.suffix.lower() not in EXTENSIONS:continue
            relative=str(path.relative_to(source))
            if path.is_symlink() or relative not in CERTIFIED_HASHES:return False
            if hashlib.sha256(path.read_bytes()).hexdigest()!=CERTIFIED_HASHES[relative]:return False
            names.append(relative)
    return set(names)==set(CERTIFIED_HASHES)



def create_fixture(output: Path, *, font_path: str = FONT_PATH) -> dict:
    from PIL import Image, ImageDraw, ImageFont

    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output / "fixture-manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("version") != FIXTURE_VERSION:
            raise ValueError("SYNTHETIC_FIXTURE_VERSION_DRIFT")
        for asset in manifest["assets"]:
            path = output / asset["filename"]
            if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != asset["sha256"]:
                raise ValueError("SYNTHETIC_FIXTURE_CONTENT_DRIFT")
        if not certified(output):raise ValueError("SYNTHETIC_FIXTURE_NOT_CERTIFIED")
        return manifest
    if not Path(font_path).is_file():
        raise ValueError("SYNTHETIC_CJK_FONT_UNAVAILABLE")
    font = ImageFont.truetype(font_path, 64)
    medium = ImageFont.truetype(font_path, 42)
    small = ImageFont.truetype(font_path, 30)
    assets = []
    specs = [
        ("01-overview.png", "overview", "synthetic-object-a"),
        ("02-detail.png", "detail", "synthetic-object-a"),
        ("03-label.png", "label", "synthetic-object-a"),
        ("04-different-object.png", "overview", "synthetic-object-b"),
    ]
    for index, (filename, role, object_id) in enumerate(specs):
        path = output / filename
        if path.exists():
            raise ValueError("SYNTHETIC_OUTPUT_ALREADY_EXISTS")
        image = Image.new("RGB", (1400, 1050), "#e5dfd1")
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 0, 1400, 115), fill="#17406c")
        draw.text((45, 23), "SYNTHETIC FIXTURE / 合成测试资料", font=medium, fill="white")
        if index == 0:
            draw.rectangle((275, 160, 1090, 820), fill="#807c74", outline="#514f4b", width=10)
            draw.rounded_rectangle((305, 190, 1060, 780), radius=18, fill="#a5a092")
            for number, text in enumerate(["合成书法石刻", "山水清音", "测试对象甲"]):
                draw.text((385, 240 + number * 150), text, font=font, fill="#272922")
            draw.rectangle((300, 865, 1120, 980), fill="#faf5e5", outline="#5c594f", width=3)
            draw.text((325, 900), LABEL_TEXT, font=medium, fill="#222222")
        elif index == 1:
            draw.rectangle((160, 175, 1260, 900), fill="#a5a092", outline="#514f4b", width=12)
            detail_font = ImageFont.truetype(font_path, 170)
            draw.text((275, 295), "山水清音", font=detail_font, fill="#252722")
            draw.line((230, 695, 1130, 620), fill="#696757", width=8)
            draw.text((310, 780), "对象甲：局部细节", font=medium, fill="#30322a")
        elif index == 2:
            draw.rectangle((100, 200, 1300, 910), fill="#fffaf0", outline="#5c594f", width=8)
            draw.text((155, 295), "展签 / SYNTHETIC LABEL", font=font, fill="#222222")
            draw.text((155, 480), LABEL_TEXT, font=font, fill="#171717")
            draw.text((155, 665), "年代原文：年代未详", font=medium, fill="#333333")
            draw.text((155, 780), "对象甲；仅作本地流程测试", font=medium, fill="#333333")
        else:
            draw.rounded_rectangle((490, 275, 925, 785), radius=50, fill="#a2472c", outline="#673120", width=12)
            draw.ellipse((410, 645, 1000, 900), fill="#9b442b", outline="#673120", width=8)
            draw.arc((335, 260, 1040, 875), 150, 280, fill="#673120", width=42)
            draw.text((410, 175), "对象乙：合成陶壶", font=font, fill="#222222")
            draw.rectangle((360, 925, 1150, 1000), fill="#fffaf0")
            draw.text((400, 940), "不同实物；不应并入书法石刻", font=medium, fill="#222222")
        draw.text((25, 1010), f"{FIXTURE_VERSION} | {filename}", font=small, fill="#17406c")
        image.save(path, format="PNG")
        assets.append({"filename": filename, "synthetic": True, "expected_role": role,
                       "synthetic_object": object_id, "width": image.width,
                       "height": image.height, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    manifest = {"version": FIXTURE_VERSION, "synthetic": True,
                "description": "Generated drawings; test fixture only; no real photos or Owner approvals",
                "font_filename": Path(font_path).name, "label_text": LABEL_TEXT, "assets": assets}
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if not certified(output):raise ValueError("SYNTHETIC_FIXTURE_NOT_CERTIFIED")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = create_fixture(args.output)
    print(json.dumps({"synthetic": True, "version": result["version"], "asset_count": len(result["assets"])}))
