# Spec de feature — issue #<N> «<título del issue>»

estado: BORRADOR | APROBADA por ___ el ___
(el sha256 lo congela `recibo.sh rojo`; cambiarla después exige causa escrita en la PR)

**Dónde vive.** El issue de GitHub es la spec canónica. Lo que se congela y se commitea es el
**dump del issue bajado por API** (`docs/specs/<n>/issue.md`, con `fetched_at` y el cuerpo
completo), y cada repo commitea su propio `docs/specs/<n>/recibo.json`. Se congela el dump y no la
copia local: así el sha certifica el texto que de verdad leyó quien implementó, y una sección que
no llegó al issue se ve sola.

**Inmutabilidad.** Issue ABIERTO = la spec se edita con causa escrita (el recibo sale DEGRADADO).
Issue CERRADO **no se edita nunca**: el cambio nace como issue NUEVO que lo cita («Continúa #12;
hereda sus DURADERAS: D1 · D2 — D3 la reemplaza este issue»).

**La spec es de la FEATURE, no del repo.** Si toca ai-assistant y agent-factory, la misma spec
gobierna las PR de los dos, y cada recibo apunta al MISMO sha.

**Reglas del artefacto — no se quitan de la copia:**
- El eje 0 y los 7 ejes SIEMPRE presentes. «No aplica» / «no se toca» es una entrada explícita
  con motivo: una fila ausente invalida la spec.
- Cada valor lleva evidencia VERIFICABLE (`archivo:línea`, tabla del esquema, issue, dump).
- **Un referente (una tabla, una columna, un scope, una tool que se reusa) solo está
  «verificado» con sus TRES anclas: DATOS** (query contra la base viva: conteo + muestra) ·
  **USO** (consumidor actual, `archivo:línea`) · **DISCRIMINACIÓN** (todo homónimo se abre y se
  descarta con motivo). Elegir por nombre es inferencia y se marca **DECISIÓN**.
- **Una spec con pendientes no congela**: ningún «[confirmar]» / «[pendiente]» vivo al publicar.
- Todo hueco que el issue no dice y el agente rellenó solo va marcado **DECISIÓN**.
- La compuerta es ACTIVA: el aprobador confirma o corrige a mano el eje de mayor riesgo y resuelve
  todas las DECISIÓN.
- **La spec que se publica al issue lleva TODAS las secciones.** Antes de cerrar la publicación:
  `bash tools/harness/spec-check.sh <borrador> <dump>` compara las secciones de los dos lados.

---

## Eje 0 — Mapa de impacto de la cadena

Toda fila se llena. Las piezas de la cadena están en `tools/harness/cadena.txt`; `spec-check.sh`
exige una fila por cada una.

> Cada pieza marcada «sí» obliga a leer el `CLAUDE.md` de ESE repo antes de escribir su parte.

| pieza | ¿tocada? | qué cambia / por qué NO se toca |
|---|---|---|
| **ai-assistant** | sí/no | ... |
| **agent-factory** | sí/no | ... |

### Issues, ramas y orden de PR

| pieza | repo e issue | rama | rol |
|---|---|---|---|
| ai-assistant | `Spinedac3/ai-assistant#<n>` | `<n>-<slug>` | hogar de la spec |

**Orden:** ... Si una pieza bloquea a otra, se dice en la primera línea del issue bloqueado
(«Bloqueado por #NN») y su rama sale apilada sobre la que la bloquea.

---

## 1. Esquema y migración
- tablas/columnas propias afectadas (`src/db/schema.ts`): ... [evidencia]
- migración (`pnpm db:generate`, revisada a mano): ... | No aplica porque ...
- datos existentes: qué pasa con las filas de antes ... | No aplica porque ...

## 2. Alcance — y qué NO se toca
- entra en este cambio: ...
- **NO se toca** (archivos, módulos, comportamientos): ...

## 3. Módulo dueño y pieza
- carpeta dueña (tabla «The folders» de `CLAUDE.md`): `src/<carpeta>/` — [existente | nuevo]
  [DECISIÓN?]
- pieza que se escribe y su ejemplar (tabla «The pieces»): [Native tool | Route module | Model
  call | ninguna] — se copia la forma de `<ejemplar>`
- reglas de dirección que toca (`tests/architecture/layers.test.ts`): ...
- **nombres**: identificadores en inglés; una tool nativa en snake_case

## 4. Contrato hacia afuera
- ruta HTTP, tool MCP o comando: [nueva | reusa `archivo:línea`]
- entrada: el esquema (zod o JSON Schema), con cada tope y su razón (`tests/architecture/caps.test.ts`)
- **permiso**: el scope que la habilita y quién lo tiene hoy [evidencia: `src/db/seed.ts`]
- **rechazos: una fila por cada forma de decir que no.**

  | qué se rechaza | código | `error` | mensaje (español) |
  |---|---|---|---|
  | entrada inválida | 400 | `invalid_body` | ... |
  | sin permiso | 403 | `forbidden` | ... |
  | no existe, o no es suyo | 404 | `..._not_found` | ... |

## 5. Retorno
- forma exacta de la respuesta o del resultado de la tool: ...
- ¿lo lee un modelo? [sí → viaja como dato no confiable; un resultado grande lo acota el registro
  por tamaño, con su Excel | no]
- ¿llama a un modelo? [sí → los datos van con `promptData` y la respuesta se lee con `jsonIn` /
  `answerText`, campo por campo | no]

## 6. Tests exigidos (de TODA la cadena tocada)

**Primero, el SEAM DECISORIO — una línea, antes del inventario.** El punto más alto donde esta
feature se demuestra viva: si está verde, la feature funciona.

> Seam decisorio: <sonda concreta> ⇒ <valor esperado que solo lo correcto produce>

- **El más alto que siga siendo barato y determinista**; por defecto, la ruta o la tool contra los
  servicios reales (`tests/integration/`), con un valor que solo la tabla o el documento correcto
  produce. Una costura nueva es infraestructura: issue aparte.
- **Panel**: el recorrido crítico contra el backend local; si no hay rieles para automatizarlo,
  **manual DECLARADO en el recibo** (`RECIBO_VALIDAR`), jamás contado como automático.
- **El CLI de Claude** en una prueba automática es un doble (`tests/support/fakeCli.mjs`); la
  prueba real con el CLI se declara como manual.

Cada test nombra el VALOR exacto que asserta; prohibido como único oráculo `toBeDefined`,
`toBeTruthy` o que un mock recibió la llamada. Cada test tiene que VERSE FALLAR (fase rojo) antes
de implementar.

- ai-assistant:
  - [ ] `tests/.../x.test.ts` › «<nombre del test>» — asserta: <valor concreto>

## 7. Criterios de aceptación verificables
Forma: CUANDO <condición> ENTONCES <resultado con valor concreto>. Cada criterio apunta al test
del eje 6 que lo cubre.

- CA-01: CUANDO ... ENTONCES ... [cubierto por 6.x]

---

## Mapa de decisiones

Una línea por decisión, en orden, con su evidencia. **Viaja al issue.**

**Duraderas: <D# · D# · ...>** — las que hereda el issue que continúe éste.

Una decisión es **DURADERA** solo si pasa las TRES preguntas: **¿difícil de revertir?** (esquema,
datos guardados, contratos que otros consumen) · **¿sorprendente sin contexto?** · **¿trade-off
real?** (se puede nombrar la alternativa perdedora). Las filas marcadas DURADERA = los D# de la
línea resumen (`spec-check.sh`, SP5).

- D1 DURADERA — <decisión> · revertir=<qué cuesta> ✓ · sorprende=<por qué> ✓ · perdedora=<alternativa> ✓
- D2 — <decisión> · sin marca: <motivo> · evidencia: <archivo:línea | query>

**NIEBLA** (se ve venir, todavía no se puede formular con precisión): ...

**FUERA DE ALCANCE** (cerrado; no vuelve a discutirse): ...

---

## Retroalimentación al método (SDD)

**Encabezado FIJO, no se renombra**: se recorre en todos los issues para capturar las mejoras del
flujo. Una entrada por hallazgo sobre el MÉTODO (no sobre el dominio): **qué se cazó · cómo entró
· quién lo cazó · arreglo y dónde vive · estado**. Sin hallazgos, dice «— sin hallazgos —».

---

## Riesgo
- **eje de mayor riesgo: <0-7>** — por qué: ...
- riesgo del cambio 0-4 (por QUÉ se toca: credenciales, permisos, datos de una fuente, lo que ve
  un modelo; no por líneas): ...

## Compuerta (la llena el humano, a mano)
- [ ] eje de mayor riesgo confirmado o corregido (editado, no solo tildado)
- [ ] **eje 0 leído fila por fila**, las «no se toca» también
- [ ] todas las **DECISIÓN** resueltas, una por una
- [ ] «NO se toca» del eje 2 leído y completo
- aprobada por: ___ · fecha: ___
