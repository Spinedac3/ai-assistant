#!/bin/bash
#
# The spec's form, checked by a machine. The rules of the artifact used to be kept by the same
# agent that writes it, which the template itself names as the default way to fail: a spec frozen
# with live pending items, a section that never reached the issue.
#
# Usage:
#   bash tools/harness/spec-check.sh <spec.md>              # the spec's form
#   bash tools/harness/spec-check.sh <spec.md> <other.md>   # + compares the ## sections (SP6)
#
# exit 0 = clean · exit 1 = violations · exit 2 = could not run
set -uo pipefail

SPEC="${1:-}"
OTRA="${2:-}"
[ -f "$SPEC" ] && [ -s "$SPEC" ] || { echo "spec-check: NO PUDO CORRER: no existe o está vacía: $SPEC"; exit 2; }

KIT="$(cd "$(dirname "$0")" && pwd)"
V=0
falla() { V=$((V+1)); echo "SP$1  $2"; }

# SP1 — axis 0 complete: one row per piece of the chain, untouched ones too. The pieces are
# listed one per line in tools/harness/cadena.txt; without the file, the chain is this repository.
if [ -f "$KIT/cadena.txt" ]; then
    PIEZAS=$(grep -vE '^\s*(#|$)' "$KIT/cadena.txt" | tr -d '\r')
else
    PIEZAS="$(basename "$(cd "$KIT/../.." && pwd)")"
fi
while IFS= read -r kw; do
    [ -z "$kw" ] && continue
    grep -qiE "^\|.*\b$kw\b" "$SPEC" || falla 1 "eje 0: falta la fila de '$kw'; una fila ausente invalida la spec"
done <<< "$PIEZAS"

# SP2 — nothing freezes with pending items
PEND='\[(confirmar|pendiente|verificar|por definir|definir despues|definir después|TBD|TODO)'
while IFS= read -r l; do
    [ -n "$l" ] && falla 2 "pendiente vivo: $l"
done < <(grep -nEi "$PEND" "$SPEC")

# SP4 — the deciding seam is declared, with content
grep -qiE '^>? ?\**Seam decisorio\**[:：].{10,}' "$SPEC" \
    || falla 4 "eje 6: falta el seam decisorio (la sonda + el valor que solo lo correcto produce)"

# SP5 — durable decisions agree: the D# of the summary line = the rows marked DURADERA
RES=$(grep -m1 -iE '^\**Duraderas[:：]' "$SPEC" || true)
FILAS=$(grep -cE '^- +D[0-9]+ +DURADERA\b' "$SPEC")
if [ -z "$RES" ]; then
    falla 5 "mapa de decisiones: falta la línea resumen '**Duraderas: ...**' (aunque sea vacía: 'Duraderas: —')"
else
    NRES=$(printf '%s' "$RES" | grep -oE 'D[0-9]+' | wc -l)
    [ "$NRES" -ne "$FILAS" ] && falla 5 "duraderas: la línea resumen lista $NRES y hay $FILAS filas marcadas DURADERA"
fi

# SP8 — the feedback section on the method exists, even when it says there was nothing
# An accented letter is two bytes outside a UTF-8 locale, so the dots take one or two
grep -qiE '^#+ +Retroalimentaci.{1,2}n al m.{1,2}todo' "$SPEC" \
    || falla 8 "falta la sección '## Retroalimentación al método (SDD)'; si no hubo hallazgos, lo dice"

# SP6 — two copies, the same sections: a section that does not travel turns proposals into facts
if [ -n "$OTRA" ]; then
    [ -f "$OTRA" ] || { echo "spec-check: NO PUDO CORRER: no existe: $OTRA"; exit 2; }
    D=$(diff <(grep -E '^## ' "$SPEC" | tr -d '\r') <(grep -E '^## ' "$OTRA" | tr -d '\r') || true)
    if [ -n "$D" ]; then
        echo "SP6  las secciones ## difieren entre $SPEC y $OTRA:"
        printf '%s\n' "$D" | sed 's/^/      /'
        V=$((V+1))
    fi
fi

echo "spec-check: $V violación(es) en $SPEC"
[ "$V" -gt 0 ] && exit 1
exit 0
