#!/usr/bin/env bash
# Подбирает CRAN_SNAPSHOT для env/Dockerfile по renv.lock: дату, на которую все версии из lock-файла
# уже вышли на CRAN. Пакеты, чья версия к этой дате уже заменена более новой (не будет бинарника в снимке
# и renv соберёт её из исходников), перечисляются отдельно.
#
# Использование: env/snapshot-date.sh [env/renv.lock]
set -euo pipefail
LOCK="${1:-$(dirname "$0")/renv.lock}"
command -v jq >/dev/null || { echo "нужен jq" >&2; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
jq -r '.Packages[] | "\(.Package) \(.Version)"' "$LOCK" > "$TMP/locked"
echo "Версии пакетов из $(wc -l < "$TMP/locked" | tr -d ' ') записей lock-файла: запрашиваю crandb.r-pkg.org" >&2
cut -d' ' -f1 "$TMP/locked" | xargs -P 10 -I{} curl -fsS -o "$TMP/{}.json" "https://crandb.r-pkg.org/{}/all" || true

while read -r p v; do
  if [ -f "$TMP/$p.json" ]; then
    jq -r --arg v "$v" --arg p "$p" '(.timeline[$v] // "NA") as $d
      | ([.timeline | to_entries[] | select($d != "NA" and .value > $d) | .value] | min // "none") as $n
      | "\($d[0:10]) \($n[0:10]) \($p) \($v)"' "$TMP/$p.json"
  else
    echo "NA none $p $v"
  fi
done < "$TMP/locked" > "$TMP/dates"

D="$(grep -v '^NA' "$TMP/dates" | sort | tail -n 1 | cut -c1-10)"
# Снимок на следующий день после последнего релиза: в снимок дня релиза пакет может не попасть
SNAP="$(date -j -v+1d -f %Y-%m-%d "$D" +%Y-%m-%d 2>/dev/null || date -d "$D + 1 day" +%Y-%m-%d)"

if grep -q '^NA' "$TMP/dates"; then
  echo "Нет на CRAN (GitHub, Bioconductor или ошибка запроса):" >&2
  grep '^NA' "$TMP/dates" | cut -d' ' -f3- | sed 's/^/  /' >&2
fi
OLD="$(awk -v d="$SNAP" '$2 != "none" && $2 <= d' "$TMP/dates")"
if [ -n "$OLD" ]; then
  echo "На $SNAP уже заменены более новыми (renv соберёт из исходников; рекомендуемые пакеты R — норма):" >&2
  echo "$OLD" | awk '{print "  " $3 " " $4 " (новая версия " $2 ")"}' >&2
fi
echo "$SNAP"
