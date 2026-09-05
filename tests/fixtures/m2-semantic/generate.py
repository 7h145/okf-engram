#!/usr/bin/env python3
"""Regenerate the sanitized binary M2 fixture with ephemeral Python packages."""

from datetime import datetime, timezone
from pathlib import Path
import re
import zipfile

from openpyxl import Workbook
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

ROOT = Path(__file__).parent / "sources"
ROOT.mkdir(parents=True, exist_ok=True)


def normalize_zip(path: Path) -> None:
    temporary = path.with_suffix(path.suffix + ".normalized")
    with zipfile.ZipFile(path, "r") as source, zipfile.ZipFile(
        temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
    ) as target:
        for name in sorted(source.namelist()):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = source.getinfo(name).external_attr
            data = source.read(name)
            if name == "docProps/core.xml":
                data = re.sub(
                    rb"<dcterms:modified[^>]*>.*?</dcterms:modified>",
                    rb'<dcterms:modified xsi:type="dcterms:W3CDTF">2000-01-01T00:00:00Z</dcterms:modified>',
                    data,
                )
            target.writestr(info, data)
    temporary.replace(path)


workbook = Workbook()
fixed_time = datetime(2000, 1, 1, tzinfo=timezone.utc)
workbook.properties.created = fixed_time
workbook.properties.modified = fixed_time
services = workbook.active
services.title = "Services"
services.append(["Component", "Responsibility", "Owning team", "State"])
services.append(["edge-gateway", "buffers events while disconnected", "Edge Platform", "stable"])
services.append(["replay-worker", "replays retained events after reconnect", "Data Plane", "stable"])
services.append(["auth-cache", "serves local authorization metadata", "Identity Systems", "stable"])
experiments = workbook.create_sheet("Experiments")
experiments.append(["Feature", "Evidence", "State"])
experiments.append(["stream-repair", "FIXME packet-loss and duplicate tests incomplete", "experimental"])
workbook_path = ROOT / "service-matrix.xlsx"
workbook.save(workbook_path)
normalize_zip(workbook_path)

text_pdf = ROOT / "offline-recovery.pdf"
pdf = canvas.Canvas(str(text_pdf), pagesize=letter, invariant=1)
pdf.setTitle("Lantern offline recovery")
pdf.setFont("Helvetica-Bold", 18)
pdf.drawString(72, 720, "Lantern offline recovery")
pdf.setFont("Helvetica", 11)
pdf.drawString(72, 690, "Controlled recovery procedure. Details continue on page 2.")
pdf.showPage()
pdf.setFont("Helvetica-Bold", 16)
pdf.drawString(72, 720, "Retained-stream replay (page 2)")
pdf.setFont("Helvetica", 11)
for index, line in enumerate([
    "After an edge node reconnects, first pause new intake for that node.",
    "Record consumer lag, then resume the durable consumer and watch lag decline.",
    "Do not purge the retained stream as a first response; purge destroys replay evidence.",
    "Escalate if lag does not decline after two reconnect backoff cycles.",
]):
    pdf.drawString(72, 685 - index * 24, line)
pdf.save()

scan_pdf = ROOT / "historical-scan.pdf"
image = Image.new("L", (1800, 700), color=255)
draw = ImageDraw.Draw(image)
title_font = ImageFont.load_default(size=42)
body_font = ImageFont.load_default(size=30)
draw.text((80, 70), "HISTORICAL NOTE — SUPERSEDED", font=title_font, fill=0)
lines = [
    "The operator UI was once called Firefly.",
    "That codename was retired in 2024.",
    "Do not use Firefly in current operator labels.",
    "Retain this note only to interpret archived screenshots.",
]
for index, line in enumerate(lines):
    draw.text((80, 165 + index * 82), line, font=body_font, fill=0)
scan = canvas.Canvas(str(scan_pdf), pagesize=letter, invariant=1)
scan.setTitle("Historical scanned note")
scan.drawImage(ImageReader(image), 36, 260, width=540, height=210, mask="auto")
scan.save()

print(f"Generated {workbook_path.name}, {text_pdf.name}, and {scan_pdf.name}")
