#!/bin/bash
#
# Fetches the issue's dump: the text that is frozen and committed (docs/specs/<n>/issue.md). The
# receipt's sha certifies this text, so anyone, CI included, can fetch it again without an agent.
#
# Usage:
#   bash tools/harness/spec-dump.sh <owner/repo> <number> [output]
#   bash tools/harness/spec-dump.sh Spinedac3/ai-assistant 12        # -> docs/specs/12/issue.md
#
# The token is optional for public repositories and required for private ones: GITHUB_TOKEN, or a
# .env file with GITHUB_TOKEN=... named by GITHUB_ENV_FILE. Read only.
#
# exit 0 = dump written · exit 2 = could not (token, network, no such issue)
set -uo pipefail

REPO="${1:-}"; NUM="${2:-}"
[ -n "$REPO" ] && [ -n "$NUM" ] || { echo "uso: spec-dump.sh <owner/repo> <numero> [salida]"; exit 2; }
SALIDA="${3:-docs/specs/$NUM/issue.md}"
URL="${GITHUB_API_URL:-https://api.github.com}"

if [ -z "${GITHUB_TOKEN:-}" ] && [ -n "${GITHUB_ENV_FILE:-}" ] && [ -f "$GITHUB_ENV_FILE" ]; then
    GITHUB_TOKEN=$(grep -m1 '^GITHUB_TOKEN=' "$GITHUB_ENV_FILE" | cut -d= -f2-)
fi

AUTH=()
[ -n "${GITHUB_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")

JSON=$(curl -sf --max-time 30 -H "Accept: application/vnd.github+json" "${AUTH[@]}" "$URL/repos/$REPO/issues/$NUM") \
    || { echo "spec-dump: NO PUDO CORRER: la API no respondió ($URL, $REPO#$NUM); en un repo privado falta GITHUB_TOKEN"; exit 2; }

mkdir -p "$(dirname "$SALIDA")"
printf '%s' "$JSON" | node -e '
    const issue = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (typeof issue.number !== "number") {
        process.stderr.write("spec-dump: respuesta sin issue\n");
        process.exit(2);
    }
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    process.stdout.write([
        "---",
        `proyecto: ${process.argv[1]}`,
        `iid: ${issue.number}`,
        `titulo: ${issue.title.replace(/\n/g, " ")}`,
        `estado: ${issue.state === "closed" ? "cerrado" : "abierto"}`,
        `actualizado_en_github: ${issue.updated_at}`,
        `fetched_at: ${local}`,
        "---",
        "",
        `${String(issue.body ?? "").replace(/\r\n/g, "\n")}`,
        "",
    ].join("\n"));
' -- "$REPO" > "$SALIDA" || exit 2

echo "spec-dump: $REPO#$NUM -> $SALIDA ($(wc -l < "$SALIDA") líneas, estado $(grep -m1 '^estado:' "$SALIDA" | cut -d' ' -f2))"
