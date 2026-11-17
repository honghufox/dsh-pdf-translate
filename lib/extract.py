"""Extract translatable text blocks from a PDF as JSON.

One JSON array of `{page, kind, text}` objects on stdout. Blocks come from
PyMuPDF's own block segmentation, so a wrapped line inside a paragraph is joined
back into one string while a genuine paragraph break stays separate. Figure and
table regions are emitted with `kind` set but carry no prose, which lets the
caller drop them; this is the main token saving versus sending page images.
"""
from __future__ import annotations

import json
import re
import sys

import pymupdf

HYPHEN_BREAK = re.compile(r'(\w)-\n(?=\w)')


def block_text(raw: str) -> str:
    joined = HYPHEN_BREAK.sub(r'\1', raw)
    # A newline inside a block is a wrapped line, not a sentence break.
    collapsed = re.sub(r'\s*\n\s*', ' ', joined).strip()
    return re.sub(r'[ \t]+', ' ', collapsed)


def main() -> int:
    if len(sys.argv) < 2:
        print('usage: extract.py <pdf>', file=sys.stderr)
        return 2
    document = pymupdf.open(sys.argv[1])
    blocks: list[dict[str, object]] = []
    try:
        for page_index, page in enumerate(document):
            for entry in page.get_text('blocks', sort=True):
                x0, y0, x1, y1, text, _number, kind = entry[:7]
                if kind != 0:
                    continue
                cleaned = block_text(text)
                if not cleaned:
                    continue
                blocks.append({
                    'page': page_index,
                    'kind': 'text',
                    'text': cleaned,
                    'bbox': [round(x0), round(y0), round(x1), round(y1)],
                })
    finally:
        document.close()
    # Write UTF-8 bytes directly: on Windows a text-mode stdout follows the
    # console code page (cp936 here) and would corrupt accented names, primes
    # and Greek letters, making the JSON unparsable on the Node side.
    sys.stdout.buffer.write(json.dumps(blocks, ensure_ascii=False).encode('utf-8'))
    sys.stdout.buffer.flush()
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
