#!/usr/bin/env python3
"""Turn REPORT_2.md into a printable REPORT_2.html, including the screenshot figures."""

from pathlib import Path
import markdown
import re

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "REPORT_2.md"
OUTPUT = ROOT / "REPORT_2.html"

text = SOURCE.read_text(encoding="utf-8")

html_content = markdown.markdown(
    text,
    extensions=["tables", "fenced_code"],
)

# Keep mermaid blocks (if any) as mermaid divs without breaking other <pre> tags.
html_content = re.sub(
    r'<pre><code class="language-mermaid">(.*?)</code></pre>',
    r'<div class="mermaid">\1</div>',
    html_content,
    flags=re.S,
)

html_content = html_content.replace("<img ", '<img class="figure" ')

full_html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Assignment 2: HTTP APIs, gRPC, and Metrics — Syed Hamza Omer (08962)</title>
<style>
  @page {{ size: A4; margin: 14mm 12mm; }}
  * {{ box-sizing: border-box; }}
  body {{
    font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 10.5pt;
    line-height: 1.45;
    color: #1f2328;
    background: #fff;
    max-width: 920px;
    margin: 0 auto;
    padding: 28px 18px 56px;
  }}
  h1 {{
    font-size: 20pt;
    margin: 0 0 8px;
    color: #123a8a;
    border-bottom: 2px solid #eaecef;
    padding-bottom: 8px;
  }}
  h2 {{
    font-size: 14pt;
    margin: 26px 0 10px;
    padding-bottom: 4px;
    border-bottom: 1px solid #d0d7de;
    page-break-after: avoid;
  }}
  h3 {{
    font-size: 12pt;
    margin: 18px 0 8px;
    page-break-after: avoid;
  }}
  p {{ margin: 0 0 10px; }}
  ul, ol {{ margin: 0 0 10px; padding-left: 22px; }}
  li {{ margin-bottom: 3px; }}
  em {{ color: #424a53; }}
  table {{
    border-collapse: collapse;
    width: 100%;
    margin: 12px 0 18px;
    font-size: 9.5pt;
  }}
  th, td {{
    border: 1px solid #d0d7de;
    padding: 6px 8px;
    vertical-align: top;
    text-align: left;
  }}
  th {{ background: #f6f8fa; }}
  code, pre {{
    font-family: Consolas, "SF Mono", Menlo, monospace;
    font-size: 8.8pt;
  }}
  code {{
    background: rgba(175, 184, 193, 0.2);
    padding: 1px 4px;
    border-radius: 4px;
  }}
  pre {{
    background: #f6f8fa;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    padding: 10px 12px;
    overflow-x: auto;
    white-space: pre-wrap;
    margin: 10px 0 14px;
  }}
  pre code {{ background: transparent; padding: 0; }}
  img.figure {{
    display: block;
    max-width: 100%;
    height: auto;
    margin: 8px 0 4px;
    border: 1px solid #d0d7de;
    border-radius: 4px;
    page-break-inside: avoid;
  }}
  p:has(img.figure) {{
    page-break-inside: avoid;
    margin-bottom: 4px;
  }}
  p em {{
    display: block;
    font-size: 9.2pt;
    margin: 0 0 16px;
  }}
  @media print {{
    body {{ max-width: 100%; padding: 0; }}
    h1, h2, h3, img.figure, table {{ page-break-inside: avoid; }}
  }}
</style>
</head>
<body>
{html_content}
</body>
</html>
"""

OUTPUT.write_text(full_html, encoding="utf-8")
print(f"Wrote {OUTPUT}")
