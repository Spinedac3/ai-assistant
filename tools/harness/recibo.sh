#!/bin/bash
# Receipt: the evidence travels with the pull request and comes from instruments, never from what
# the agent says. It records VALUES, not exit codes, and it CAN record red: an instrument that
# only records success always reports success.
#
# Usage (the target repository goes in RECIBO_REPO, by default this one):
#   bash tools/harness/recibo.sh rojo  <issue> <spec.md> <tests...>  # the spec's tests seen failing
#   bash tools/harness/recibo.sh verde <issue> <spec.md> <tests...>  # tests + gates -> recibo.json
#   bash tools/harness/recibo.sh autochequeo                         # the freshness guard, fed both cases
#
# <spec.md> is the issue's dump (docs/specs/<n>/issue.md, from spec-dump.sh), never a copy by
# hand: it carries "fetched_at:" and is fetched again in EVERY phase, or the sha freezes a text
# the issue no longer has. The tests run with vitest, integration ones included, so the services
# must be up when the spec lists any.
set -u
S="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$S/../.." && pwd)"
REPO="${RECIBO_REPO:-$ROOT}"
FASE="${1:-}"

# FRESHNESS GUARD. An edited issue whose dump was not fetched again would have the sha certify a
# text nobody reads any more, so the dump must be from today in every phase.
verificar_frescura() { # $1 = spec file; $2 = today, injectable for the self-check
    local f="$1" hoy="${2:-$(date +%F)}" cuando
    cuando=$(grep -m1 -E "^fetched_at:" "$f" | tr -d '\r' | awk '{print $2}' | cut -dT -f1)
    if [ -z "$cuando" ]; then
        echo "ADVERTENCIA: la spec no trae 'fetched_at': no hay forma de saber si el issue cambió después de esta copia."
        return 0
    fi
    if [ "$cuando" != "$hoy" ]; then
        echo "el dump del issue es del $cuando y hoy es $hoy: bájalo de nuevo antes de congelar, el issue pudo cambiar." >&2
        return 1
    fi
    return 0
}

if [ "$FASE" = "autochequeo" ]; then
    T=$(mktemp -d); F=0
    printf 'titulo: x\n' > "$T/sin.md"
    printf 'fetched_at: 2020-01-01\n' > "$T/viejo.md"
    printf 'fetched_at: 2030-12-31T09:00\n' > "$T/hoy.md"
    verificar_frescura "$T/sin.md" 2030-12-31 > /dev/null || { echo "FALLA: sin fetched_at debe pasar con advertencia"; F=1; }
    verificar_frescura "$T/viejo.md" 2030-12-31 2>/dev/null && { echo "FALLA: un dump viejo debe cortar"; F=1; }
    verificar_frescura "$T/hoy.md" 2030-12-31 > /dev/null || { echo "FALLA: un dump de hoy debe pasar"; F=1; }
    rm -rf "$T"
    [ "$F" -eq 0 ] && echo "autochequeo ok: la guarda de frescura corta el dump viejo y deja pasar el del día"
    exit "$F"
fi

if [ $# -lt 4 ]; then
    echo "uso: recibo.sh rojo|verde <issue> <spec.md> <tests...>"
    exit 2
fi
ISSUE="$2"
SPEC="$3"
shift 3
TESTS=("$@")
# The issue names folders: <repo>-<number>, nothing that climbs out of them
[[ "$ISSUE" =~ ^[A-Za-z0-9_.-]+-[0-9]+$ ]] || { echo "issue inválido: '$ISSUE' (se espera <repo>-<número>)"; exit 2; }

[ -f "$SPEC" ] || { echo "spec inexistente: $SPEC"; exit 2; }
# Absolute before moving into the repository, or a relative spec breaks and its sha comes out empty
SPEC="$(cd "$(dirname "$SPEC")" && pwd)/$(basename "$SPEC")"
cd "$REPO" || { echo "repo inexistente: $REPO"; exit 2; }
RNAME="$(basename "$REPO")"
# Named relative to the repository: a path of the developer's machine has no place in a receipt
SPEC_REL="${SPEC#"$(pwd)/"}"
DIR="${RECIBO_CORRIDAS:-$ROOT/_local/corridas}/$ISSUE/$RNAME"
mkdir -p "$DIR"

json_str() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' -- "$1"; }
json_lineas() { # file of lines -> JSON array
    node -e '
        const fs = require("fs");
        const lines = fs.existsSync(process.argv[1]) ? fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/).filter(Boolean) : [];
        process.stdout.write(JSON.stringify(lines));
    ' -- "$1"
}
campo() { node -e 'const v = JSON.parse(process.argv[1])[process.argv[2]]; process.stdout.write(Array.isArray(v) ? v.join("\n") : String(v))' -- "$1" "$2"; }

# The session does not expose its model to bash: it travels in RECIBO_MODELO or the receipt limps
if [ -z "${RECIBO_MODELO:-}" ]; then
    echo "ADVERTENCIA: RECIBO_MODELO sin declarar: el recibo dirá 'no-registrado'."
fi

verificar_frescura "$SPEC" || exit 2
# A CLOSED issue is immutable: a changed text is not a change of scope, it goes in a NEW issue
ISSUE_CERRADO=false
grep -qiE "^estado: *(cerrado|closed)" "$SPEC" && ISSUE_CERRADO=true
# The sha covers the BODY, not the front matter: fetched_at changes every day with the same text
sha_cuerpo() { awk 'c>=2{print} /^---$/{c++}' "$1" | tr -d '\r' | sha256sum | cut -d' ' -f1; }
SPEC_SHA=$(sha_cuerpo "$SPEC")
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo sin-git)
RAMA=$(git branch --show-current 2>/dev/null || echo "")
FECHA=$(date +%Y-%m-%dT%H:%M:%S)
NODEV=$(node --version)

correr_tests() { # $1 = junit output; leaves the log in $DIR. Returns 1 when any test fails.
    rm -f "$1"
    INTEGRATION_TESTS=true pnpm -s exec vitest run --no-file-parallelism \
        --reporter=default --reporter=junit --outputFile.junit="$1" "${TESTS[@]}" \
        > "$DIR/vitest-$FASE.log" 2>&1
}

leer_junit() { # $1 = junit file; prints the parser's JSON or stops loudly
    local r
    r=$(node "$S/junit.mjs" "$1")
    if printf '%s' "$r" | grep -q '"error"'; then
        echo "la corrida no entregó un junit legible: esta NO es una fase válida. Últimas líneas:" >&2
        tail -5 "$DIR/vitest-$FASE.log" >&2
        exit 2
    fi
    printf '%s' "$r"
}

no_corrieron() { # $1 = the parser's JSON; prints each listed test file that did not run
    # vitest takes its arguments as filters, so a misspelled or excluded path runs nothing, quietly
    node -e '
        const ran = JSON.parse(process.argv[1]).files;
        for (const path of process.argv.slice(2)) {
            const wanted = path.replace(/\\/g, "/").replace(/^\.\//, "");
            if (!ran.includes(wanted)) console.log(wanted);
        }
    ' -- "$1" "${TESTS[@]}"
}

case "$FASE" in
rojo)
    # The form is checked BEFORE freezing: a malformed spec would be built whole and break in verde
    if ! bash "$S/spec-check.sh" "$SPEC_REL"; then
        echo "rojo: la spec NO pasa la forma: arréglala en el ISSUE, baja el dump otra vez (spec-dump.sh) y vuelve." >&2
        exit 1
    fi
    # Frozen on the first rojo of this repository; later runs add up
    if [ ! -f "$DIR/spec-congelada.sha" ]; then
        echo "$SPEC_SHA" > "$DIR/spec-congelada.sha"
        cp "$SPEC" "$DIR/spec-congelada.md"
    fi
    correr_tests "$DIR/rojo.xml" || true
    # leer_junit's exit dies in the subshell: passed on, or the failure cascades
    R=$(leer_junit "$DIR/rojo.xml") || exit 2
    FALTAN=$(no_corrieron "$R")
    if [ -n "$FALTAN" ]; then
        echo "rojo: estos archivos de la lista no corrieron (¿ruta mal escrita o excluida?): $FALTAN" >&2
        exit 2
    fi
    T=$(campo "$R" tests)
    F=$(campo "$R" failures)
    campo "$R" failed >> "$DIR/rojos.txt"
    echo >> "$DIR/rojos.txt"
    sed -i '/^$/d' "$DIR/rojos.txt"
    sort -u "$DIR/rojos.txt" -o "$DIR/rojos.txt"
    echo "$FECHA commit=$COMMIT tests=$T fallas=$F" >> "$DIR/rojo-corridas.log"
    echo "rojo [$RNAME]: $T tests, $F vistos fallar (acumulado: $(wc -l < "$DIR/rojos.txt"))"
    if [ "$F" -eq 0 ]; then
        echo "ADVERTENCIA: 0 fallas en fase rojo: un test que no se vio fallar no existe."
        echo "$FECHA ADVERTENCIA-0-FALLAS" >> "$DIR/rojo-corridas.log"
    fi
    ;;

verde)
    [ -f "$DIR/rojo-corridas.log" ] || { echo "sin fase rojo no hay recibo: corre 'rojo' primero"; exit 2; }

    SPEC_CAMBIADA=false
    CONGELADA_SHA=$(cat "$DIR/spec-congelada.sha")
    [ "$SPEC_SHA" != "$CONGELADA_SHA" ] && SPEC_CAMBIADA=true

    correr_tests "$DIR/verde.xml" || true
    RV=$(leer_junit "$DIR/verde.xml") || exit 2
    TV=$(campo "$RV" tests)
    FV=$(campo "$RV" failures)
    campo "$RV" names | sort -u > "$DIR/verde-nombres.txt"
    touch "$DIR/rojos.txt"
    comm -23 "$DIR/verde-nombres.txt" "$DIR/rojos.txt" > "$DIR/nunca-rojos-crudo.txt"
    # Only NEW tests must be seen failing: one that already existed on the base was born green,
    # and counting it would degrade every receipt that extends a test file
    BASE_BRANCH="${BASE_BRANCH:-${GITHUB_BASE_REF:-main}}"
    BASE_REF="origin/$BASE_BRANCH"
    git rev-parse -q --verify "$BASE_REF" > /dev/null 2>&1 || BASE_REF="$BASE_BRANCH"
    node "$S/newTests.mjs" "$BASE_REF" < "$DIR/nunca-rojos-crudo.txt" > "$DIR/nunca-rojos.txt"
    TESTS_JSON="{\"corridos\":$TV,\"fallas\":$FV,\"nunca_rojos\":$(json_lineas "$DIR/nunca-rojos.txt")}"

    # The repository's gates: exit 2 means the gate could not run, which is neither green nor red
    GATES_JSON=""
    GATE_FALLO=0
    GATE_NO_CORRIO=0
    : > "$DIR/no-revisado.txt"
    # A listed file that did not run, or a run with no test, measures nothing
    FALTAN=$(no_corrieron "$RV")
    if [ -n "$FALTAN" ] || [ "$TV" -eq 0 ]; then
        GATE_NO_CORRIO=1
        echo "tests: no corrieron todos los archivos de la lista (${FALTAN:-ningún test}): no dice ni verde ni rojo" >> "$DIR/no-revisado.txt"
    fi
    correr_gate() { # $1 = name; the rest is the command
        local nombre="$1" out e res
        shift
        if ! command -v pnpm > /dev/null 2>&1; then
            GATE_NO_CORRIO=1
            echo "gate $nombre: NO PUDO correr (sin pnpm): no dice ni verde ni rojo" >> "$DIR/no-revisado.txt"
            return
        fi
        out=$("$@" 2>&1)
        e=$?
        [ "$e" -ne 0 ] && GATE_FALLO=1
        printf '%s\n' "$out" > "$DIR/gate-$nombre.log"
        # The count of tests says more than the run's duration, which vitest prints last
        res=$(printf '%s\n' "$out" | grep -E '^\s*Tests ' | tail -1)
        [ -z "$res" ] && res=$(printf '%s\n' "$out" | grep -v '^\s*$' | tail -1)
        [ -n "$GATES_JSON" ] && GATES_JSON="$GATES_JSON,"
        GATES_JSON="$GATES_JSON\"$nombre\":{\"exit\":$e,\"resumen\":$(json_str "$res")}"
    }
    correr_gate typecheck pnpm -s typecheck
    correr_gate lint pnpm -s lint
    correr_gate architecture pnpm -s exec vitest run tests/architecture

    # The spec's own form, same treatment as the gates: 2 = INCONCLUSIVE, 1 = FAILING
    OUT=$(bash "$S/spec-check.sh" "$SPEC_REL" 2>&1)
    E=$?
    if [ "$E" -eq 2 ]; then
        GATE_NO_CORRIO=1
        echo "gate spec: NO PUDO correr (exit 2): no dice ni verde ni rojo" >> "$DIR/no-revisado.txt"
    elif [ "$E" -ne 0 ]; then
        GATE_FALLO=1
    fi
    printf '%s\n' "$OUT" > "$DIR/gate-spec.log"
    RES=$(printf '%s\n' "$OUT" | tail -1)
    GATES_JSON="$GATES_JSON,\"spec\":{\"exit\":$E,\"resumen\":$(json_str "$RES")}"

    # What no instrument here checks, said out loud so nobody reads it as checked
    [ -z "${RECIBO_VALIDAR:-}" ] && echo "validación del dev: sin lista; si la spec exige un recorrido o un CA manual, este recibo no dice qué validar" >> "$DIR/no-revisado.txt"
    echo "triangular: sin instrumento que lo verifique; la PR debe decir qué caso se buscó contra lo construido" >> "$DIR/no-revisado.txt"
    echo "si el cambio hace lo que se pidió: ningún gate lo mide; lo revisa el humano contra la spec" >> "$DIR/no-revisado.txt"
    echo "la coherencia entre las PR de la cadena: todavía no hay gate que la mire" >> "$DIR/no-revisado.txt"
    echo "tests fuera de la lista de la spec: aquí no corren; la suite completa la corre la CI de la PR" >> "$DIR/no-revisado.txt"

    # State: FALLANDO > INCONCLUSO > DEGRADADO > APROBABLE. Red is recorded, never hidden, and
    # nothing unmeasured is called red.
    ESTADO="APROBABLE"
    NOTAS="$DIR/notas.txt"
    : > "$NOTAS"
    [ -s "$DIR/nunca-rojos.txt" ] && { ESTADO="DEGRADADO"; echo "hay tests NUEVOS que nacieron en verde: nunca se los vio fallar, así que todavía no prueban nada (lista en nunca_rojos)" >> "$NOTAS"; }
    [ "$SPEC_CAMBIADA" = true ] && { ESTADO="DEGRADADO"; echo "la spec cambió entre el rojo y el verde: la causa se explica en la PR" >> "$NOTAS"; }
    { [ "$SPEC_CAMBIADA" = true ] && [ "$ISSUE_CERRADO" = true ]; } && { ESTADO="FALLANDO"; echo "el issue está CERRADO y su texto cambió: el cambio va en un issue NUEVO que cite a este" >> "$NOTAS"; }
    [ "$GATE_NO_CORRIO" -eq 1 ] && { ESTADO="INCONCLUSO"; echo "un verificador NO PUDO correr (cuál, en no_revisado): se resuelve y se repite, no se aprueba" >> "$NOTAS"; }
    { [ "$FV" -gt 0 ] || [ "$GATE_FALLO" -eq 1 ]; } && { ESTADO="FALLANDO"; echo "tests o gates en rojo" >> "$NOTAS"; }

    cat > "$DIR/recibo.json" <<EOF
{
  "recibo": "v0",
  "leeme": "APROBABLE = todo lo medido en verde · DEGRADADO = aprobable si las causas de 'notas' convencen · INCONCLUSO = un verificador no pudo correr: se resuelve y se repite · FALLANDO = no aprobar. 'no_revisado' lista lo que este recibo NO mira.",
  "issue": $(json_str "$ISSUE"),
  "repo": $(json_str "$RNAME"),
  "rama": $(json_str "$RAMA"),
  "fecha": $(json_str "$FECHA"),
  "commit": $(json_str "$COMMIT"),
  "node": $(json_str "$NODEV"),
  "modelo": $(json_str "${RECIBO_MODELO:-no-registrado}"),
  "validacion_del_dev": $([ -n "${RECIBO_VALIDAR:-}" ] && json_str "PENDIENTE de recorrer por el dev: $RECIBO_VALIDAR" || echo null),
  "spec": {
    "sha256": $(json_str "$CONGELADA_SHA"),
    "cambiada": $SPEC_CAMBIADA
  },
  "fase_rojo": {
    "corridas": $(grep -c 'commit=' "$DIR/rojo-corridas.log"),
    "tests_vistos_fallar": $(json_lineas "$DIR/rojos.txt")
  },
  "tests": $TESTS_JSON,
  "gates": {$GATES_JSON},
  "estado": $(json_str "$ESTADO"),
  "notas": $(json_lineas "$NOTAS"),
  "no_revisado": $(json_lineas "$DIR/no-revisado.txt")
}
EOF
    # The evidence is committed with the change, in a folder named by the issue's number
    IID="${ISSUE##*-}"
    mkdir -p "docs/specs/$IID"
    cp "$DIR/recibo.json" "docs/specs/$IID/recibo.json"
    echo "recibo [$RNAME]: $ESTADO — docs/specs/$IID/recibo.json (logs en $DIR)"
    cat "$DIR/recibo.json"
    echo ""
    echo "-> pega el bloque en la descripción de la PR (fence \`\`\`json)."
    case "$ESTADO" in FALLANDO|INCONCLUSO) exit 1 ;; esac
    exit 0
    ;;

*)
    echo "uso: recibo.sh rojo|verde <issue> <spec.md> <tests...>"
    exit 2
    ;;
esac
