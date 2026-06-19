#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUTPUT_DIR="$SCRIPT_DIR/output"
CNAME_FILE="$OUTPUT_DIR/CNAME"

if [ ! -d "$OUTPUT_DIR" ]; then
  printf 'Missing output directory: %s\n' "$OUTPUT_DIR" >&2
  printf 'Render the sample first with:\n' >&2
  printf '  deno run -A ./render-doc-html.ts --input ./sample/docs --output ./sample/output/index.html --title "Sample Docs"\n' >&2
  exit 1
fi

if ! command -v surge >/dev/null 2>&1; then
  printf 'surge command not found. Install it with:\n' >&2
  printf '  npm install --global surge\n' >&2
  exit 1
fi

if [ ! -f "$CNAME_FILE" ]; then
  printf 'Missing CNAME file: %s\n' "$CNAME_FILE" >&2
  printf 'Add your Surge domain to that file before deploying.\n' >&2
  exit 1
fi

surge "$OUTPUT_DIR"
