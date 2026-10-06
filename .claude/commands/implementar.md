# /implementar <n> — lleva un issue de 7 ejes hasta su recibo

Se puede correr muchas veces: cada vez calcula dónde quedó el trabajo y sigue por la pieza
siguiente. La spec canónica ES el cuerpo del issue; este comando no inventa alcance.

## Paso 1 — Lee el issue

`$ARGUMENTS` es `<n>` (issue de este repo) o `<owner/repo>#<n>` cuando el hogar de la spec vive en
otro repo de la cadena.

**Baja el dump**: `bash tools/harness/spec-dump.sh <owner/repo> <n>` → `docs/specs/<n>/issue.md`.
Ese dump ES la spec que se congela; se baja otra vez en CADA fase, y `recibo.sh` corta si no es del
día. Del eje 0 salen qué piezas se tocan y cuáles no; de «Issues, ramas y orden de PR», dónde va
cada una. Si el issue no tiene spec de 7 ejes, PARA y dilo.

## Paso 2 — Calcula el estado, de instrumentos

| pregunta | evidencia |
|---|---|
| ¿ya está cerrada esta pieza? | `_local/corridas/<repo>-<n>/<repo>/recibo.json` y su `estado` |
| ¿quedó a medio camino? | hay `rojo-corridas.log` pero no `recibo.json` |
| ¿tiene PR? | `gh pr list --head <rama>` |

Muéstralo antes de tocar nada:

```
issue <n> — <título>
  ai-assistant    ▸ SIGUIENTE   rama <n>-<slug>
  agent-factory   — no se toca (eje 0)
```

## Paso 3 — Lee la doctrina del repo de ESA pieza

Su `CLAUDE.md`, antes de abrir un archivo de código: entrar con `cd` a otro repo no la carga.

## Paso 4 — Rama

`git fetch && git checkout <rama>`; si no existe, se crea desde `main` con el nombre de la spec.

## Paso 5 — FASE ROJA

Los tests del eje 6, escritos DESDE la spec; si el archivo existe, se extiende. Asserts de VALOR
exacto. Los de integración necesitan los servicios arriba
(`docker compose --profile engines up -d`).

```
RECIBO_MODELO=<modelo-de-la-sesión> \
  bash tools/harness/recibo.sh rojo ai-assistant-<n> docs/specs/<n>/issue.md <archivos de test...>
```

**TODOS deben fallar.** Uno que pasa en rojo está mal escrito: se arregla antes de seguir. Si la
spec declara sondas manuales, `RECIBO_VALIDAR="<la línea del seam>"`, y se sigue sin esperar el
recorrido.

## Paso 6 — IMPLEMENTACIÓN

Con el agente del repo (`assistant-backend`), guiada por los ejes 1 a 5 y respetando al pie de la
letra el «NO se toca» del eje 2. **Al agente se le pasa el dump congelado y la doctrina, nada
resumido.** Una migración se PROPONE y se corre contra la base local, nunca contra otra.

Un homónimo resuelto implementando → fila a `docs/glosario.md` en esa misma PR.

## Paso 7 — FASE VERDE

```
RECIBO_MODELO=<modelo-de-la-sesión> \
  bash tools/harness/recibo.sh verde ai-assistant-<n> docs/specs/<n>/issue.md <archivos de test...>
```

Exigido: `nunca_rojos` vacío y estado APROBABLE. DEGRADADO o FALLANDO: el recibo dice por qué; se
arregla y se repite. INCONCLUSO: un verificador no pudo correr; se hace correr y se repite.

## Paso 8 — TRIANGULAR

Los tests los escribió el grill contra el diseño, cuando este código no existía. **Busca a
propósito UN caso que rompa lo que acabas de escribir**, leyendo la implementación: el borde de la
validación, la columna nula, el PDF sin páginas, la persona sin permiso, el texto del modelo que no
es JSON.

- Sale ROJO → es un defecto: entra al ciclo rojo → verde como cualquier test.
- Sale VERDE → el test queda (documenta el borde) y la PR dice qué caso se buscó.
- Es una pregunta de ALCANCE → va como DECISIÓN al issue.

## Paso 9 — CIERRE de la pieza

1. `pnpm check` y `pnpm test:integration` completos.
2. Revisión de calidad y de seguridad sobre `git diff main..HEAD`, en paralelo; cada hallazgo se
   corrige con su test.
3. Mutantes de los cambios críticos: cada uno tiene que morir; uno que sobrevive gana su test.
4. Revisión otra vez sobre las correcciones.

Commits en el formato del repo (`:gitmoji: Asunto corto`, sin trailers de asistente). La evidencia
se commitea con el cambio: `docs/specs/<n>/issue.md` y `docs/specs/<n>/recibo.json`. **La evidencia
no entra al código**: ni conteos ni fechas en comentarios; van a la PR y a la spec.

**No hagas push ni abras la PR**: presenta el recibo, `git log --oneline` y el resumen del diff, y
espera el OK. Con el OK: push y `/pr`.

## Reglas fijas

- Lo que la spec no dice y tuviste que decidir → DECISIÓN, nunca relleno en silencio.
- La spec es inmutable tras el rojo. Si un hallazgo exige cambiarla, se PARA y se consulta.
- Un issue cerrado no se edita: el cambio nace como issue nuevo que lo cita.
- **Lo del flujo va en su propia PR; lo del issue, en la suya.** Doctrina, gates y comandos nunca
  entran en la PR de una feature.
