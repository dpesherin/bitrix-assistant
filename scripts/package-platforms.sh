#!/usr/bin/env bash
#
# Платформенные VSIX: в каждый пакет попадает только его PHP-бинарник.
# Универсальный пакет со всеми пятью бинарниками слишком большой (124+ МБ).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGETS=(darwin-arm64 darwin-x64 linux-arm64 linux-x64 win32-x64)
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/bitrix-vsix.XXXXXX")"
RESTORE=()

restore() {
  for file in "${RESTORE[@]:-}"; do
    if [[ -f "$STAGE/$(basename "$file")" ]]; then
      mv "$STAGE/$(basename "$file")" "$file"
    fi
  done
}
cleanup() {
  restore
  rmdir "$STAGE" 2>/dev/null || true
}
trap cleanup EXIT

for target in "${TARGETS[@]}"; do
  keep="php-$target"
  [[ "$target" == win32-* ]] && keep="php-$target.exe"
  for file in server/bin/php-*; do
    [[ -e "$file" ]] || continue
    [[ "$(basename "$file")" == "$keep" ]] && continue
    mv "$file" "$STAGE/"
    RESTORE+=("$file")
  done
  echo "==> $target"
  npx --yes @vscode/vsce package --target "$target" -o "/tmp/bitrix-assistant-$target.vsix" >/dev/null
  echo "  /tmp/bitrix-assistant-$target.vsix ($(du -h "/tmp/bitrix-assistant-$target.vsix" | cut -f1))"
  restore
  RESTORE=()
done
