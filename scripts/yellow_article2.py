import zipfile
from io import BytesIO

from lxml import etree

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
path = r"C:\Users\Denis\Desktop\Lipatov_article_2.docx"
raw = zipfile.ZipFile(path).read("word/document.xml")
root = etree.parse(BytesIO(raw), etree.XMLParser(remove_blank_text=False)).getroot()


def is_yellow(run):
    highlight = run.find("w:rPr/w:highlight", NS)
    return highlight is not None and highlight.get(W + "val") == "yellow"


def run_text(run):
    return "".join(node.text or "" for node in run.findall("w:t", NS))


groups = []
for paragraph in root.iter(W + "p"):
    current = []
    parts = []
    for child in paragraph:
        if child.tag == W + "r" and is_yellow(child):
            current.append(run_text(child))
        else:
            if current:
                groups.append("".join(current))
                parts.append("[[" + "".join(current) + "]]")
                current = []
            if child.tag == W + "r":
                parts.append(run_text(child))
    if current:
        groups.append("".join(current))
        parts.append("[[" + "".join(current) + "]]")
    if "[[" in "".join(parts):
        pass

out = r"C:\Users\Denis\Desktop\migration-scale-stand\results\yellow-groups.txt"
body = []
index = 0
for paragraph in root.iter(W + "p"):
    current = []
    shown = []
    yellow = False
    for child in paragraph:
        if child.tag == W + "r" and is_yellow(child):
            yellow = True
            current.append(run_text(child))
        else:
            if current:
                text = "".join(current)
                shown.append(f"{{{index}}}{text}")
                index += 1
                current = []
            if child.tag == W + "r":
                shown.append(run_text(child))
    if current:
        text = "".join(current)
        shown.append(f"{{{index}}}{text}")
        index += 1
    if yellow:
        body.append("".join(shown))

open(out, "w", encoding="utf-8").write("\n---\n".join(body))
print("groups", index)
