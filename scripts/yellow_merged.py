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


lines = []
for paragraph in root.iter(W + "p"):
    current = []
    context = []
    for run in paragraph.findall("w:r", NS):
        text = run_text(run)
        if is_yellow(run):
            current.append(text)
        else:
            if current:
                lines.append("".join(current))
                current = []
            context.append(text)
    if current:
        lines.append("".join(current))

out = r"C:\Users\Denis\Desktop\migration-scale-stand\results\yellow-merged.txt"
open(out, "w", encoding="utf-8").write("\n".join(f"{i}\t{text}" for i, text in enumerate(lines)))
print(len(lines))
