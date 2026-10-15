import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(r"C:\Users\Denis\Desktop\migration-scale-stand")
DATA = json.loads((ROOT / "results" / "article-numbers.json").read_text(encoding="utf-8"))
FONT = Path(r"C:\Windows\Fonts\arial.ttf")
FONT_BOLD = Path(r"C:\Windows\Fonts\arialbd.ttf")

COLORS = {
    0: (31, 78, 121),
    5: (22, 138, 110),
    20: (176, 96, 16),
}
PATH_COLORS = {
    "direct": (31, 78, 121),
    "session": (22, 138, 110),
    "transaction": (176, 96, 16),
}


def font(size, bold=False):
    return ImageFont.truetype(str(FONT_BOLD if bold else FONT), size)


def draw_fig2(target):
    width, height = 1800, 760
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    title_font = font(22, True)
    label_font = font(18)
    tick_font = font(16)
    panels = DATA["figure2"]
    gap = 24
    left = 78
    top = 70
    panel_w = (width - left - 30 - gap * (len(panels) - 1)) // len(panels)
    panel_h = height - top - 88
    values = []
    for panel in panels:
        for series in panel["series"]:
            values.extend(series["high"])
            values.extend(series["line"])
    y_max = max(values) * 1.08
    magnitude = 10 ** int(math.floor(math.log10(y_max)))
    step = magnitude / 2
    y_max = math.ceil(y_max / step) * step
    y_min = 0

    def y_of(value, origin):
        return origin + panel_h - (value - y_min) / (y_max - y_min) * panel_h

    legend_x = left
    for latency, color in COLORS.items():
        draw.line((legend_x, 28, legend_x + 28, 28), fill=color, width=3)
        draw.text((legend_x + 34, 16), f"{latency} мс", font=label_font, fill=color)
        legend_x += 130
    draw.text((legend_x + 20, 16), "смуга: 2,5–97,5 % запусків, лінія: a + bN", font=label_font, fill=(60, 60, 60))

    for index, panel in enumerate(panels):
        origin_x = left + index * (panel_w + gap)
        origin_y = top
        draw.text((origin_x, origin_y - 34), panel["label"], font=title_font, fill=(20, 20, 20))
        draw.line((origin_x, origin_y, origin_x, origin_y + panel_h), fill=(40, 40, 40), width=2)
        draw.line((origin_x, origin_y + panel_h, origin_x + panel_w, origin_y + panel_h), fill=(40, 40, 40), width=2)
        for step in range(5):
            value = y_max * step / 4
            y = y_of(value, origin_y)
            draw.line((origin_x, y, origin_x + panel_w, y), fill=(230, 230, 230), width=1)
            if index == 0:
                draw.text((8, y - 10), f"{value:.0f}", font=tick_font, fill=(40, 40, 40))
        ns = panel["series"][0]["ns"]
        for n in ns:
            x = origin_x + (n - 2) / (64 - 2) * (panel_w - 16) + 8
            extra = 18 if n == 4 else 0
            draw.text((x - 10, origin_y + panel_h + 6 + extra), str(n), font=tick_font, fill=(40, 40, 40))
        for series in panel["series"]:
            color = COLORS[series["latency"]]
            points = []
            fit = []
            for n, low, high, med, line in zip(series["ns"], series["low"], series["high"], series["medians"], series["line"]):
                x = origin_x + (n - 2) / (64 - 2) * (panel_w - 16) + 8
                draw.line((x, y_of(low, origin_y), x, y_of(high, origin_y)), fill=color, width=2)
                y = y_of(med, origin_y)
                draw.ellipse((x - 4, y - 4, x + 4, y + 4), fill=color)
                points.append((x, y))
                fit.append((x, y_of(line, origin_y)))
            if len(fit) > 1:
                draw.line(fit, fill=color, width=2)
        if index == 0:
            draw.text((8, origin_y - 34), "мс", font=label_font, fill=(40, 40, 40))
        draw.text((origin_x + panel_w / 2 - 10, height - 22), "N", font=label_font, fill=(40, 40, 40))
    image.save(target)


def draw_fig3(target):
    width, height = 1400, 780
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    label_font = font(20)
    tick_font = font(16)
    left, top = 90, 50
    plot_w, plot_h = width - 420, height - 120
    highs = []
    for series in DATA["figure3"]:
        highs.extend(series["high"])
        highs.extend(series["line"])
    y_max = max(highs) * 1.12
    magnitude = 10 ** int(math.floor(math.log10(max(y_max, 1))))
    step = magnitude / 2
    y_max = math.ceil(y_max / step) * step
    y_min = 0

    def x_of(latency):
        return left + (latency / 20) * plot_w

    def y_of(value):
        return top + plot_h - (value - y_min) / (y_max - y_min) * plot_h

    draw.line((left, top, left, top + plot_h), fill=(40, 40, 40), width=2)
    draw.line((left, top + plot_h, left + plot_w, top + plot_h), fill=(40, 40, 40), width=2)
    for step in range(5):
        value = y_max * step / 4
        y = y_of(value)
        draw.line((left, y, left + plot_w, y), fill=(230, 230, 230), width=1)
        draw.text((8, y - 10), f"{value:.0f}", font=tick_font, fill=(40, 40, 40))
    for latency in (0, 5, 20):
        x = x_of(latency)
        draw.text((x - 8, top + plot_h + 10), str(latency), font=tick_font, fill=(40, 40, 40))
    draw.text((left + plot_w / 2 - 80, height - 32), "Затримка d, мс", font=label_font, fill=(40, 40, 40))
    draw.text((8, 8), "tп, мс", font=label_font, fill=(40, 40, 40))
    legend_y = 16
    for series in DATA["figure3"]:
        color = PATH_COLORS[series["key"]]
        points = []
        line = []
        for latency, tp, low, high, fitted in zip(series["latency"], series["tp"], series["low"], series["high"], series["line"]):
            x = x_of(latency)
            draw.line((x, y_of(low), x, y_of(high)), fill=color, width=3)
            y = y_of(tp)
            draw.ellipse((x - 5, y - 5, x + 5, y + 5), fill=color)
            points.append((x, y))
            line.append((x, y_of(fitted)))
        draw.line(line, fill=color, width=2)
        draw.line((left + plot_w + 24, legend_y + 8, left + plot_w + 64, legend_y + 8), fill=color, width=3)
        draw.text((left + plot_w + 74, legend_y), series["label"], font=label_font, fill=color)
        legend_y += 32
    image.save(target)


if __name__ == "__main__":
    draw_fig2(ROOT / "results" / "fig2.png")
    draw_fig3(ROOT / "results" / "fig3.png")
    print("figures ok")
