#!/usr/bin/env python3
"""
build_doctrine_index.py — extract the local FD Books corpus into the doctrine
index KeyStone's "Ask the Manuals" panel searches.

LOCAL ONLY: the corpus and the index it produces are copyrighted FDNY
material. The output lives in server/data/doctrine/ (gitignored) and is never
bundled into the client, a public build, or any cloud service.

Usage:
    python3 server/scripts/build_doctrine_index.py            # default corpus path
    FDBOOKS_DIR="/path/to/FD Books" python3 server/scripts/build_doctrine_index.py

Output:
    server/data/doctrine/doctrine-index.json.gz   one record per PDF page:
        { "t": topic id, "b": book title, "d": chapter/doc title,
          "f": relative file path, "p": 1-based page, "x": text }
    server/data/doctrine/doctrine-report.json     stats + pages needing OCR
"""

import gzip
import json
import os
import re
import sys
import time

try:
    from pypdf import PdfReader
except ImportError:
    sys.exit("pypdf required: pip3 install --user pypdf")

DEFAULT_CORPUS = os.path.expanduser("~/Downloads/2nd Quarter Full Books 2026/FD Books")
CORPUS = os.environ.get("FDBOOKS_DIR", DEFAULT_CORPUS)
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "doctrine")

WS = re.compile(r"\s+")


def main() -> None:
    index_path = os.path.join(CORPUS, "index.json")
    if not os.path.exists(index_path):
        sys.exit(f"{index_path} not found — run the corpus's build-fdbooks-index.py first")
    with open(index_path) as f:
        library = json.load(f)

    os.makedirs(OUT_DIR, exist_ok=True)
    chunks = []
    needs_ocr = []
    failed = []
    pdf_count = 0
    t0 = time.time()

    for pub in library.get("publications", []):
        topic = pub.get("topic") or pub.get("id") or "unknown"
        book = pub.get("title") or topic
        for ch in pub.get("chapters", []):
            rel = ch.get("rel") or ch.get("file")
            if not rel or not rel.lower().endswith(".pdf"):
                continue
            path = os.path.join(CORPUS, rel)
            if not os.path.exists(path):
                continue
            pdf_count += 1
            doc_title = ch.get("title") or os.path.basename(rel)
            try:
                reader = PdfReader(path)
                text_pages = 0
                for i, page in enumerate(reader.pages):
                    try:
                        text = WS.sub(" ", page.extract_text() or "").strip()
                    except Exception:
                        text = ""
                    if len(text) < 40:  # blank / image-only page
                        continue
                    text_pages += 1
                    chunks.append({"t": topic, "b": book, "d": doc_title, "f": rel, "p": i + 1, "x": text})
                if text_pages == 0 and len(reader.pages) > 0:
                    # Scanned/image-only document — OCR fallback not available
                    # in this environment; report honestly instead of guessing.
                    needs_ocr.append(rel)
            except Exception as e:  # encrypted / corrupt PDFs must not kill the run
                failed.append({"file": rel, "error": str(e)[:200]})
            if pdf_count % 100 == 0:
                print(f"  {pdf_count} PDFs, {len(chunks)} pages, {time.time() - t0:.0f}s", flush=True)

    out = os.path.join(OUT_DIR, "doctrine-index.json.gz")
    with gzip.open(out, "wt", encoding="utf-8") as f:
        json.dump(chunks, f, ensure_ascii=False, separators=(",", ":"))

    report = {
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "corpus": CORPUS,
        "pdfs": pdf_count,
        "pages": len(chunks),
        "needsOcr": needs_ocr,
        "failed": failed,
        "seconds": round(time.time() - t0),
    }
    with open(os.path.join(OUT_DIR, "doctrine-report.json"), "w") as f:
        json.dump(report, f, indent=1)

    print(
        f"Indexed {pdf_count} PDFs -> {len(chunks)} text pages in {report['seconds']}s "
        f"({len(needs_ocr)} docs need OCR, {len(failed)} failed) -> {out}"
    )


if __name__ == "__main__":
    main()
