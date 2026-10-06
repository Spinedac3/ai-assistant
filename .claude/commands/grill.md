# /grill <premisa> — de la premisa a la spec y el issue, conversando

La entrada del flujo. Todo desarrollo arranca aquí: una premisa (frase, párrafo o imagen del
pedido) se convierte en spec de 7 ejes y en issue, ANTES de escribir una línea de código. Después
sigue `/implementar <n>`.

Excepción de ceremonia: un bug obvio de menos de 2 archivos salta el grill y va directo a
rojo → verde con recibo (`/implementar` sobre un issue corto).

## Paso 1 — Lee la premisa COMPLETA

Antes de abrir un solo archivo. Si es una imagen, descríbela de vuelta para confirmar que la
leíste bien.

## Paso 2 — Entrevista con exploración

Mapea el trabajo como un **árbol de decisiones**: cada decisión se ramifica en las que cuelgan de
ella. La **frontera** es toda decisión cuyos prerrequisitos ya están resueltos: lo que se puede
preguntar AHORA sin adivinar respuestas que todavía no llegaron. Pregunta la frontera entera en
una ronda, cada pregunta con tu respuesta recomendada, y espera las respuestas antes de la ronda
siguiente.

**La ronda se presenta con la herramienta de opciones** (`AskUserQuestion`): hasta 4 preguntas por
tanda, la recomendada primera con `(Recommended)`. El cuerpo de la pregunta lleva el contexto
entero y cada opción su descripción con la misma sustancia que tendría en prosa: qué implica, su
evidencia (`archivo:línea` o query) y su costo. Una opción escueta obliga a preguntar dos veces.

- **Al presentar de nuevo, SOLO lo abierto.** Lo ya respondido no se ofrece otra vez.
- **Un pedido de ampliación se RESPONDE, no se vuelve a preguntar**: primero la ampliación en
  prosa con su evidencia, después solo esa pregunta.
- **Una opción que contradice `CLAUDE.md` NO se ofrece.** Si la doctrina ya eligió, la decisión
  se deriva y se confirma en una línea.

**Bitácora de rondas, al RECIBIR cada tanda**, una línea en
`_local/corridas/<slug>/grill-rondas.jsonl`:

```json
{"ronda":1,"preguntas":6,"con_recomendada":4,"corregidas":1,"propias":1,"hechos_despachados":2}
```

La señal de alarma son rondas contestadas siempre con la recomendada y nunca corregidas: un grill
sano tiene correcciones.

**Buscar los HECHOS es tu trabajo; las DECISIONES son de la persona.** Qué tabla, qué columna, qué
usa hoy la pantalla equivalente, qué scope existe: despacha un subagente (con el modelo fijado en
el despacho, nunca heredado) y no le preguntes nada que puedas averiguar. Solo esperan las
preguntas que cuelgan de ese hecho. Todo subagente despachado se cosecha.

**Antes de la primera pregunta, lee `docs/glosario.md`.** Durante la entrevista, cuatro conductas,
todas con el mismo corte (se afirma con `archivo:línea` o con un `SELECT`, nunca con una
impresión):

- **Confrontar contra el glosario** cuando la persona usa un término que choca con lo escrito.
- **Afilar lo difuso**: un término que abarca dos cosas se parte antes de decidir sobre él.
- **Escenarios de borde**: la fila sin ninguno de los campos, la que aparece dos veces, el PDF de
  trescientas páginas, la persona sin el permiso.
- **Contrastar contra el código**, a la persona también, con la línea en la mano.

**Las tres anclas de un referente** (una tabla, una columna, un scope, una tool que se reusa):

1. **DATOS** — query contra la base local (`.env` → `DATABASE_URL`, o una fuente demo), conteo y
   muestra, pegada en la spec. La sonda es un `SELECT`, jamás una escritura.
2. **USO** — el consumidor actual, `archivo:línea`.
3. **DISCRIMINACIÓN** — todo homónimo que aparezca se abre y se descarta con motivo; el resultado
   se escribe en `docs/glosario.md`.

**El seam decisorio no es un menú: es una derivación que se confirma.** Preséntalo con la pregunta
«¿Cómo validamos que esta feature funciona?» y tres líneas: *qué se hace* · *qué tiene que
devolver* (el valor que solo lo correcto produce) · *qué queda manual y quién lo recorre*.

**Nada congela con pendientes**: cero `[confirmar]` / `[pendiente]` al colapsar.

**No se grilla el PROCESO** (ramas, orden de PR, dónde vive la spec): eso lo dice este flujo; es
un hecho, no una decisión. **No se grilla cómo se ve**: se marca `ALTA FIDELIDAD`, se resuelve con
una captura o un prototipo enlazado en la spec, y la entrevista sigue.

## Paso 3 — Colapso a spec

La spec se escribe en `_local/corridas/<slug>/spec.md` (git la ignora), con la estructura de
`docs/plantilla-7ejes.md`, que no se toca. Se llena DESDE la conversación, sin entrevistar de
nuevo. Todo hueco que rellenes solo va marcado **DECISIÓN**.

## Paso 4 — Issue y rama (SOLO con OK explícito)

El hogar de la spec es el ISSUE: título + spec COMPLETA.

- **Antes de publicar**: `bash tools/harness/spec-check.sh _local/corridas/<slug>/spec.md`.
- **Después**: `bash tools/harness/spec-dump.sh Spinedac3/ai-assistant <n>` y
  `bash tools/harness/spec-check.sh <borrador> docs/specs/<n>/issue.md`.

El issue se crea con `gh issue create`; la rama es `<n>-<slug-corto>`. **Nada se publica sin el OK
de la persona.** Con el issue creado, la bitácora queda como `docs/specs/<n>/grill.json`.

## Después

Ofrece en el mismo turno el paso siguiente: `/implementar <n>`.
