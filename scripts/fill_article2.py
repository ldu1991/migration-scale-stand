import json
import shutil
import zipfile
from io import BytesIO
from pathlib import Path

from lxml import etree
from PIL import Image

SRC = Path(r"C:\Users\Denis\Desktop\Lipatov_article_2.docx")
BACKUP = Path(r"C:\Users\Denis\Desktop\Lipatov_article_2-до-правок.docx")
NUMBERS = Path(r"C:\Users\Denis\Desktop\migration-scale-stand\results\article-numbers.json")
FIG2 = Path(r"C:\Users\Denis\Desktop\migration-scale-stand\results\fig2.png")
FIG3 = Path(r"C:\Users\Denis\Desktop\migration-scale-stand\results\fig3.png")

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
SKIP = object()
AUTHORS_UA = "Ліпатов Д. Ю., Хрипко О. С., Ковтун В. А., Хрипко С. Л."
AUTHORS_EN = "Lipatov D. Yu., Hrypko O. S., Kovtun V. A., Khrypko S. L."


def is_yellow(run):
    highlight = run.find("w:rPr/w:highlight", NS)
    return highlight is not None and highlight.get(W + "val") == "yellow"


def run_text(run):
    return "".join(node.text or "" for node in run.findall("w:t", NS))


def paragraph_text(paragraph):
    return "".join(node.text or "" for node in paragraph.findall(".//w:t", NS))


def yellow_groups(root):
    groups = []
    plain = []
    for index, paragraph in enumerate(root.iter(W + "p")):
        current = []
        yellow_here = False
        for run in paragraph.findall("w:r", NS):
            if is_yellow(run):
                yellow_here = True
                current.append(run)
            elif current:
                groups.append(current)
                current = []
        if current:
            groups.append(current)
        if not yellow_here:
            plain.append((index, paragraph_text(paragraph)))
    return groups, plain


def drop_highlight(run):
    rpr = run.find("w:rPr", NS)
    if rpr is None:
        return
    highlight = rpr.find("w:highlight", NS)
    if highlight is not None:
        rpr.remove(highlight)


def nearest_run(start, direction):
    node = start
    while node is not None:
        node = node.getprevious() if direction < 0 else node.getnext()
        if node is not None and node.tag == W + "r":
            return node
    return None


def texts_of(element):
    if element is None or element.tag != W + "r":
        return []
    return element.findall("w:t", NS)


def drawing_xml(rid, doc_id, name, cx, cy):
    return f'''<w:drawing xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="{doc_id}" name="{name}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{doc_id}" name="{name}"/><pic:cNvPicPr><a:picLocks noChangeAspect="1" noChangeArrowheads="1"/></pic:cNvPicPr></pic:nvPicPr><pic:blipFill><a:blip r:embed="{rid}"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr bwMode="auto"><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>'''


def center_paragraph(paragraph):
    ppr = paragraph.find("w:pPr", NS)
    if ppr is None:
        ppr = etree.Element(W + "pPr")
        paragraph.insert(0, ppr)
    jc = ppr.find("w:jc", NS)
    if jc is None:
        jc = etree.SubElement(ppr, W + "jc")
    jc.set(W + "val", "center")


def apply_group(runs, new):
    if new is SKIP:
        return
    parent = runs[0].getparent()
    if isinstance(new, tuple) and new[0] == "image":
        _, rid, doc_id, name, png = new
        with Image.open(png) as picture:
            cx = 5334000
            cy = int(cx * picture.height / picture.width)
        for run in runs:
            parent.remove(run)
        run = etree.SubElement(parent, W + "r")
        run.append(etree.fromstring(drawing_xml(rid, doc_id, name, cx, cy)))
        center_paragraph(parent)
        return
    if new == "":
        first = runs[0]
        last = runs[-1]
        prev = nearest_run(first, -1)
        nxt = nearest_run(last, 1)
        for run in runs:
            parent.remove(run)
        prev_text = texts_of(prev)
        next_text = texts_of(nxt)
        if prev_text and next_text and prev_text[-1].text and next_text[0].text:
            if prev_text[-1].text.endswith(" ") and next_text[0].text.startswith(" "):
                next_text[0].text = next_text[0].text[1:]
            if prev_text[-1].text.endswith(" ") and next_text[0].text.startswith("."):
                prev_text[-1].text = prev_text[-1].text[:-1]
        return
    nodes = runs[0].findall("w:t", NS)
    nodes[0].text = new
    if new[:1] == " " or new[-1:] == " ":
        nodes[0].set(XML_SPACE, "preserve")
    for extra in nodes[1:]:
        extra.getparent().remove(extra)
    drop_highlight(runs[0])
    for run in runs[1:]:
        parent.remove(run)


def replace_span(paragraph, old, new):
    pieces = []
    for run in paragraph.findall("w:r", NS):
        pieces.extend(run.findall("w:t", NS))
    if not pieces:
        return False
    joined = "".join(node.text or "" for node in pieces)
    start = joined.find(old)
    if start < 0:
        return False
    end = start + len(old)
    cursor = 0
    first = True
    for node in pieces:
        text = node.text or ""
        node_start = cursor
        node_end = cursor + len(text)
        cursor = node_end
        if node_end <= start or node_start >= end:
            continue
        local_start = max(0, start - node_start)
        local_end = min(len(text), end - node_start)
        if first:
            node.text = text[:local_start] + new + text[local_end:]
            first = False
        else:
            node.text = text[:local_start] + text[local_end:]
        if node.text[:1] == " " or (node.text and node.text[-1:] == " "):
            node.set(XML_SPACE, "preserve")
    return True


def replace_text(root, old, new):
    count = 0
    for paragraph in root.iter(W + "p"):
        if replace_span(paragraph, old, new):
            count += 1
    return count


def load_root(path):
    raw = zipfile.ZipFile(path).read("word/document.xml")
    parser = etree.XMLParser(remove_blank_text=False)
    return raw, etree.parse(BytesIO(raw), parser).getroot()


def save_document(path, root, images):
    original = zipfile.ZipFile(path).read("word/document.xml")
    declaration, _ = original.split(b"?>", 1)
    body = etree.tostring(root, xml_declaration=False, encoding="UTF-8")
    new_xml = declaration + b"?>\r\n" + body.lstrip()
    source = zipfile.ZipFile(path)
    rels = source.read("word/_rels/document.xml.rels")
    rel_root = etree.fromstring(rels)
    rel_ns = "http://schemas.openxmlformats.org/package/2006/relationships"
    for rid, _png in images:
        node = etree.SubElement(rel_root, f"{{{rel_ns}}}Relationship")
        node.set("Id", rid)
        node.set("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image")
        node.set("Target", f"media/{rid}.png")
    rel_xml = etree.tostring(rel_root, xml_declaration=True, encoding="UTF-8", standalone=True)
    infos = [(info, source.read(info.filename)) for info in source.infolist()]
    source.close()
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as output:
        for info, data in infos:
            if info.filename == "word/document.xml":
                data = new_xml
            elif info.filename == "word/_rels/document.xml.rels":
                data = rel_xml
            output.writestr(info, data)
        for rid, png in images:
            info = zipfile.ZipInfo(f"word/media/{rid}.png")
            info.compress_type = zipfile.ZIP_DEFLATED
            output.writestr(info, Path(png).read_bytes())
    path.write_bytes(buffer.getvalue())


def planned(data):
    image2 = ("image", "rId8", 2, "Рисунок 2", FIG2)
    image3 = ("image", "rId9", 3, "Рисунок 3", FIG3)
    items = [SKIP] * 6
    items += [
        data["pgbouncer"],
        data["lockCount"],
        data["controlCount"],
        data["slopeUa"],
        data["r2Ua"],
        data["verdictUa"],
        SKIP,
        data["pgbouncer"],
        data["lockCountEn"],
        data["controlCountEn"],
        data["slopeEn"],
        data["r2En"],
        data["verdictEn"],
        "",
        "",
        "",
        SKIP,
        SKIP,
        "20",
        "3",
        data["pgbouncer"],
        data["pg"],
        data["toxiproxy"],
        SKIP,
        data["roundTrips"],
        data["control"],
        data["table3"],
    ]
    items += data["table3Cells"]
    items.append(data["table4"])
    items += data["table4Cells"]
    items.append(image2)
    items.append(data["table5"])
    items += data["table5Cells"]
    items.append(image3)
    items += [
        data["discussion"],
        data["conclusion1"],
        data["conclusion2"],
        data["conclusion3"],
        "",
        "15.10.2026",
        "15.10.2026",
        "15.10.2026",
        AUTHORS_UA,
        SKIP,
        AUTHORS_UA,
        SKIP,
        "15.10.2026",
        "15.10.2026",
        "15.10.2026",
        "",
        "",
        "15 October 2026",
        "15 October 2026",
        "15 October 2026",
        AUTHORS_EN,
        SKIP,
        AUTHORS_EN,
        SKIP,
        "15 October 2026",
        "15 October 2026",
        "15 October 2026",
        "",
        "",
    ]
    return items


def main():
    data = json.loads(NUMBERS.read_text(encoding="utf-8"))
    if data["runs"] != 2190 or data["standFailures"]:
        raise SystemExit(f"series is incomplete: {data['runs']} failures {data['standFailures']}")
    items = planned(data)
    shutil.copy2(SRC, BACKUP)
    _, root = load_root(SRC)
    groups, plain_before = yellow_groups(root)
    print("groups", len(groups), "planned", len(items))
    if len(groups) != len(items):
        raise SystemExit("group count does not match")
    mismatches = []
    for index, (group, new) in enumerate(zip(groups, items)):
        if new is SKIP or isinstance(new, tuple):
            continue
        actual = "".join(run_text(run) for run in group)
        if not actual.startswith("["):
            mismatches.append(f"{index} {actual[:80]}")
    if mismatches:
        raise SystemExit("unexpected groups\n" + "\n".join(mismatches[:20]))
    for group, new in zip(groups, items):
        apply_group(group, new)
    ua_intervals = replace_text(root, "(95 % інтервал […])", "(95 % інтервали в табл. 5)")
    en_intervals = replace_text(root, "(95% interval […])", "(95% intervals in Table 5)")
    latency = replace_text(
        root,
        "затримка кожного обміну може становити кілька мілісекунд",
        "до кожного обміну з базою додається мережева затримка",
    )
    semicolon = replace_text(root, "учасників;", "учасників")
    print("black", ua_intervals, en_intervals, latency, semicolon)
    if [ua_intervals, en_intervals, latency, semicolon] != [1, 1, 1, 1]:
        raise SystemExit("black-text replacement count is not 1")
    save_document(SRC, root, [("rId8", FIG2), ("rId9", FIG3)])
    _, check = load_root(SRC)
    paragraphs = list(check.iter(W + "p"))
    changed = 0
    for index, text in plain_before:
        if paragraph_text(paragraphs[index]) != text:
            changed += 1
    left = yellow_groups(check)[0]
    lines = ["".join(run_text(run) for run in group) for group in left]
    report = Path(r"C:\Users\Denis\Desktop\migration-scale-stand\results\yellow-after.txt")
    report.write_text("\n".join(lines), encoding="utf-8")
    print("yellow left", len(lines), "plain changed", changed)


if __name__ == "__main__":
    main()
