#!/usr/bin/env bash
#
# Сборка артефактов LSP: phar + (опционально) статический PHP через static-php-cli.
#
#   bash scripts/build-php.sh              # только phar (нужен локальный php)
#   SPC=/path/to/spc bash scripts/build-php.sh   # phar + бинарник под текущую платформу
#
# Бинарники для остальных платформ собираются на соответствующей ОС/в CI
# и кладутся в server/bin/php-<os>-<arch>.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PHP_BIN="${PHP_BIN:-php}"
command -v "$PHP_BIN" >/dev/null 2>&1 || {
  echo "Не найден php. Укажите PHP_BIN=/path/to/php" >&2
  exit 1
}

mkdir -p server/bin

echo "==> Сборка server/bin/bitrix-lsp.phar"
"$PHP_BIN" -d phar.readonly=0 scripts/build-phar.php

# Стабы встроенного PHP лежат в репозитории и собраны полным PHP с обычным набором
# расширений (filter, curl, dom, intl, bcmath…). Пересобирать их минимальным
# static-бинарником нельзя: тогда пропадают функции расширений, которых в нём нет,
# и появляются ложные «функция не найдена». Пересборка — только вручную:
#   BITRIX_REBUILD_STUBS=1 PHP=/opt/homebrew/bin/php bash scripts/build-php.sh
if [ "${BITRIX_REBUILD_STUBS:-0}" = "1" ]; then
	echo "==> Стабы встроенного PHP (server/data/php-stubs.json)"
	"$PHP_BIN" scripts/build-php-stubs.php
else
	echo "==> Стабы PHP: уже в репозитории, пропускаю (BITRIX_REBUILD_STUBS=1 — пересобрать)"
fi

PLATFORM="$("${NODE_BIN:-node}" -p "process.platform + '-' + process.arch")"
case "$PLATFORM" in
  win32-x64) BINARY_NAME="php-win32-x64.exe" ;;
  darwin-x64 | darwin-arm64 | linux-x64 | linux-arm64) BINARY_NAME="php-$PLATFORM" ;;
  *)
    echo "Платформа $PLATFORM не поддерживается." >&2
    exit 1
    ;;
esac

if [[ -z "${SPC:-}" ]]; then
  if command -v spc >/dev/null 2>&1; then
    SPC="$(command -v spc)"
  fi
fi

if [[ -z "${SPC:-}" ]]; then
  echo
  echo "phar готов. Статический PHP не собран: spc не найден."
  echo "Скачайте static-php-cli и повторите:"
  echo "  curl -#fSL https://dl.static-php.dev/v3/spc-bin/nightly/spc-linux-x86_64 -o spc"
  echo "  chmod +x spc && ./spc doctor --auto-fix"
  echo "  SPC=./spc bash scripts/build-php.sh"
  exit 0
fi

echo "==> Сборка статического PHP ($PLATFORM) через $SPC"
if "$SPC" --version 2>/dev/null | grep -qE '^[^0-9]*3\.'; then
  "$SPC" craft
else
  "$SPC" build --build-cli
fi

if [[ -f buildroot/bin/php ]]; then
  cp buildroot/bin/php "server/bin/$BINARY_NAME"
else
  echo "Не найден buildroot/bin/php — проверьте версию static-php-cli." >&2
  exit 1
fi

chmod +x "server/bin/$BINARY_NAME" 2>/dev/null || true

echo
echo "Готово:"
echo "  server/bin/bitrix-lsp.phar"
echo "  server/bin/$BINARY_NAME"
"server/bin/$BINARY_NAME" -v 2>/dev/null | head -n 2 || true
