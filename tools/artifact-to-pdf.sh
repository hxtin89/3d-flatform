#!/usr/bin/env bash
#
# Render a published Artifact's HTML to a print-ready PDF.
#
#   tools/artifact-to-pdf.sh page.html [out.pdf]
#
# Artifacts are published without a document skeleton — no doctype, no <head>, no
# <body>, because those are added at publish time. This wraps the file so a browser
# renders it the same way the published page does, then prints it.
#
# Two things have to be forced, and both were bugs the first time round:
#
#   data-theme="light"   A headless browser reports prefers-color-scheme: dark, and an
#                        artifact's dark palette lives inside that media query. Printing
#                        as-is put dark text tokens on white paper. Artifacts write their
#                        dark overrides as :root:not([data-theme="light"]), so stamping
#                        the attribute selects the light palette deterministically —
#                        no !important, no guessing which declaration wins.
#
#   virtual-time-budget  Google Fonts are fetched over the network. Without waiting, the
#                        PDF silently embeds fallback faces instead. The check at the end
#                        fails the run if no webfont made it in, so a silent fallback
#                        cannot pass unnoticed.
set -euo pipefail

src="${1:-}"
if [[ -z "$src" || ! -f "$src" ]]; then
  echo "usage: $(basename "$0") <artifact.html> [out.pdf]" >&2
  exit 2
fi

out="${2:-${src%.html}.pdf}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
wrapped="$work/print.html"

browser=''
for candidate in \
  "/c/Program Files/Google/Chrome/Application/chrome.exe" \
  "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
  "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
  "$(command -v google-chrome || true)" \
  "$(command -v chromium || true)"
do
  [[ -n "$candidate" && -f "$candidate" ]] && { browser="$candidate"; break; }
done
[[ -n "$browser" ]] || { echo "no Chrome or Edge found" >&2; exit 1; }

{
  cat <<'HEAD'
<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  @page { size: A4; margin: 16mm 14mm 18mm; }
  @media print {
    .page { padding: 0; max-width: none; }
    /* Keep each unit of meaning on one page: a measurement table or a diagram split
       across a break stops being readable as a single claim. */
    .band, pre, figure, .chart, .callout, .table-wrap, table { break-inside: avoid; }
    ul.ruled > li { break-inside: avoid; }
    h1, h2, h3 { break-after: avoid; }
    section { margin-bottom: 2rem; }
    header.masthead { margin-bottom: 2rem; }
    /* Link colour and underlines carry nothing on paper. */
    a { color: inherit; text-decoration: none; }
  }
</style>
</head>
<body>
HEAD
  cat "$src"
  printf '\n</body>\n</html>\n'
} > "$wrapped"

# Windows browsers need a Windows path in the file:// URL and for the output.
topath() { command -v cygpath >/dev/null 2>&1 && cygpath -w "$1" || printf '%s' "$1"; }

"$browser" \
  --headless=new \
  --disable-gpu \
  --no-pdf-header-footer \
  --virtual-time-budget=15000 \
  --print-to-pdf="$(topath "$out")" \
  "file:///$(topath "$wrapped")" >/dev/null 2>&1

[[ -s "$out" ]] || { echo "no PDF written" >&2; exit 1; }

python - "$out" "$src" <<'CHECK'
import io, re, sys

pdf, src = sys.argv[1], sys.argv[2]
data = io.open(pdf, 'rb').read()
pages = len(re.findall(rb'/Type\s*/Page[^s]', data))
embedded = sorted({f.decode() for f in re.findall(rb'/BaseFont\s*/[A-Z]{6}\+([A-Za-z0-9\-]+)', data)})
print(f'{pdf}  {len(data) // 1024} kB  {pages} pages')
print('fonts embedded: ' + (', '.join(embedded) or 'NONE'))

# A page whose webfonts never arrived still prints, just in the wrong typeface — so the
# render is checked against what the page actually asked for. Listing known fallbacks
# instead does not work: any system face outside that list passes as a success, which is
# how the first version of this check waved through a fully fallback-rendered PDF.
html = io.open(src, encoding='utf-8', errors='replace').read()
requested = []
for href in re.findall(r'fonts\.googleapis\.com/css2\?([^"\'>]+)', html):
    requested += [f.split(':')[0].replace('+', ' ') for f in re.findall(r'family=([^&]+)', href)]

def norm(name):
    return re.sub(r'[^A-Za-z0-9]', '', name).lower()

# Chrome names the embedded subset after the face, not the CSS family, and abbreviates:
# "IBM Plex Sans Condensed" arrives as "IBMPlexSansCond". Accept a prefix in either
# direction, but only where the shorter name is nearly as long — otherwise plain "Sans"
# would vouch for "Sans Condensed".
bases = {norm(f.split('-')[0]) for f in embedded}
missing = [
    family for family in requested
    if not any(b.startswith(norm(family))
               or (norm(family).startswith(b) and len(b) >= len(norm(family)) - 6)
               for b in bases)
]

if requested:
    print('fonts requested: ' + ', '.join(requested))
if missing:
    sys.exit('FAILED: requested but not embedded: ' + ', '.join(missing)
             + '. The webfonts did not load; the PDF is set in fallback faces.')
CHECK
