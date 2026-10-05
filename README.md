# ai-assistant

> **In English:** a generic AI assistant — chat, document search (RAG) and a declarative SQL tool
> builder — served over MCP. Work in progress.

Asistente de IA genérico: chat, búsqueda en documentos (RAG) y un creador de tools sobre SQL
declarativo, expuesto por MCP para que cualquier cliente lo use. Su pareja es
[agent-factory](https://github.com/Spinedac3/agent-factory), que arma agentes programados sobre
estas tools.

**En construcción.** Este README crece con cada rebanada.

## Cómo se corre

Necesitás Node 22, pnpm, Docker y el [CLI de Claude](https://docs.claude.com/en/docs/claude-code) instalado y con sesión iniciada: el chat corre cada turno como `claude -p`.

```bash
pnpm install
cp .env.example .env
docker compose --profile engines up -d   # postgres, solr, embed, minio y las bases demo
pnpm keys:generate              # llave RS256 en secrets/, nunca en variables
pnpm kek:generate               # llave maestra de las contraseñas de las fuentes
pnpm db:migrate
pnpm admin:create --email tu@empresa.com --name "Tu Nombre"
pnpm dev                        # http://localhost:3000/health
pnpm --filter ai-assistant-web build   # el panel, que el servidor sirve en http://localhost:3000/panel
pnpm check                      # typecheck + lint + tests unitarios
pnpm demo:seed                  # base demo de la distribuidora
pnpm test:integration           # también los que usan Postgres, Solr, MinIO y las bases demo
```

## Panel

Una web en `/panel` con el chat interno, los documentos y, según los permisos de cada persona, la
administración. La sirve el mismo servidor desde `PANEL_DIR` (por defecto `web/dist`), así que no
hace falta CORS. En desarrollo, `pnpm --filter ai-assistant-web dev` la levanta con Vite y usa el
servidor local como API. El color de marca se cambia con `VITE_BRAND_COLOR` al construirla.

En el chat se puede adjuntar un PDF de hasta 10 MB: queda en memoria media hora desde su último
uso, solo para quien lo subió, y el modelo lo lee con la tool `read_pdf`, que abre una llamada al
CLI que solo puede leer ese archivo.

## Entrar

| Ruta | Para qué |
|---|---|
| `POST /auth/login` | Correo y contraseña. Bloquea la cuenta 15 minutos tras 5 fallos |
| `POST /auth/system-login` | Token firmado (HS256 o RS256) por un sistema declarado en `EXTERNAL_SYSTEMS_FILE` |
| `GET /.well-known/jwks.json` | Llave pública para que otros servicios verifiquen los tokens |
| `GET /auth/me` | Quién soy y qué permisos tengo |
| `POST /auth/sessions/revoke` | Cierra todas mis sesiones |

Los tokens duran 15 minutos y se renuevan solos mientras hay actividad: la respuesta trae uno
nuevo en el header `x-renewed-token`.

## Chat

| Ruta | Para qué |
|---|---|
| `POST /chat/stream` | Un turno en streaming (SSE): `start`, `delta`, `tool_call_pending`, `tool_result`, `done` o `error` |
| `POST /chat/send` | El mismo turno, respondido de una vez |
| `GET /chat/conversations` | Mis conversaciones (`?q=` busca por título) |
| `GET /chat/conversations/:id` | Una conversación con sus mensajes |
| `PATCH /chat/conversations/:id` | Renombrarla |
| `POST /chat/messages/:id/rate` | Calificar una respuesta; con 1 o 2 estrellas pide el porqué |

Cada respuesta termina con las fuentes que de verdad se consultaron, o con "Respondido sin
consultar fuentes". Si el modelo anuncia una consulta y no la hace, escribe llamadas como texto o
afirma cifras sin fuente, el turno se reintenta en una sesión nueva; si vuelve a pasar, se responde
que no se pudo, nunca un dato inventado.

El modelo se elige en la administración (`PUT /admin/settings/chat.model`, permiso
`settings.manage`) y aplica desde el siguiente mensaje, sin reiniciar. Si nadie lo eligió se usa
`CHAT_MODEL`, que por defecto es `claude-opus-5-5`.

## Herramientas y MCP

El asistente expone sus herramientas por **MCP** en `POST /mcp` (SDK oficial, sin sesiones). Lo
que ve cada quien lo decide una sola función:

| Quién llama | Qué ve |
|---|---|
| El chat del asistente | `find_capability` y `run_capability`: descubre la herramienta con su esquema y la ejecuta. Además `search` y `fetch` para los documentos |
| Un cliente externo (Claude, ChatGPT…) | Lo mismo, más un parámetro `original_question` (salvo en `search` y `fetch`) que se guarda 90 días para mejorar el catálogo |
| La corrida de un agente | Solo sus herramientas, directas, con su esquema de salida |

`find_capability` ordena las capacidades por significado con el mismo servicio de vectores de los
documentos, y por palabras si ese servicio no responde.

Cada llamada pasa por la misma puerta: permisos, validación de entrada y de salida contra el
esquema declarado, limpieza de caracteres invisibles y auditoría en `tool_calls`. La auditoría
guarda quién, qué, cuándo, con qué argumentos y si funcionó, **nunca el resultado**. Los resultados
viajan al proveedor del modelo como parte de la conversación.

El chat obtiene en cada turno un token propio, atado a la persona y a la conversación, que se
revoca al terminar.

### Conectar Claude, ChatGPT u otro cliente MCP

El asistente es su propio servidor OAuth 2.1, así que un cliente externo se conecta solo con la
URL `https://<tu-dominio>/mcp`:

1. El cliente recibe un 401 que le dice dónde están los metadatos
   (`/.well-known/oauth-protected-resource`) y se registra solo en `POST /oauth/register`.
2. Abre en el navegador la página de consentimiento: la persona entra con su correo y contraseña
   y decide si permite o rechaza.
3. El cliente canjea el código con PKCE (S256) y recibe un token de 1 hora y un refresh de 90
   días, que rota en cada uso. Si el refresh anterior vuelve a aparecer pasados unos segundos de
   la rotación, la sesión entera se revoca: alguien tiene una copia robada. Dentro de esos
   segundos se toma como el mismo cliente pidiendo dos veces y solo se rechaza.

El token nunca da más de lo que la persona ya puede hacer: sus permisos salen de su rol en cada
llamada. Revocar sus sesiones (`POST /auth/sessions/revoke`) también corta estos tokens.

El registro está abierto a cualquier redirect `https` o a esta máquina (`localhost`, `127.0.0.1`,
`[::1]`, donde el puerto puede cambiar entre intentos), porque cada cliente igual necesita que una persona real entre y
acepte; cada registro queda en la auditoría y hay un máximo de 10 por IP cada 10 minutos.

Detrás de un proxy (nginx, un balanceador) hay que poner en `TRUST_PROXY` sus direcciones o CIDR;
sin eso se ignora `X-Forwarded-For`, porque cualquiera puede escribirlo y elegiría la IP que ven los
límites y la auditoría.

Para que los clientes en la nube lleguen, el servidor tiene que estar publicado con HTTPS y `PUBLIC_BASE_URL`
tiene que tener esa dirección.

En Windows, `CLAUDE_BIN` tiene que apuntar al `claude.exe` real: Node no ejecuta el
`claude.cmd` sin una shell.

## Documentos

El asistente busca en los documentos de la organización (procedimientos, políticas, manuales).
Solr guarda el índice, el servicio `embed` (bge-m3) convierte el texto en vectores y MinIO guarda
los originales.

### Cargar documentos

Cada documento entra como `.md` con un encabezado:

```markdown
---
doc_code: BOD-PRO-RECEP-V001
doc_title: Procedimiento de recepción de mercadería
doc_version: V001
area: general
doc_revision: R000          # opcional
doc_type: procedimiento     # opcional
effective_date: 2026-01-15  # opcional
tags: [bodega, recepción]   # opcional
---

# Título

## Sección
...
```

- **`area`** decide quién lo lee: hace falta el permiso `docs.<area>.read`. De fábrica existe
  `docs.general.read`, que tiene el rol `user`; las demás áreas se crean como permisos y se
  asignan a roles. La carga por la API rechaza un área que no existe; `pnpm docs:load` no lo
  verifica.
- **Versiones**: los códigos que solo difieren en el sufijo `-V001`, `-V002`… son una familia (un
  código sin sufijo cuenta como la versión 0 de la suya). Subir una versión mueve las demás de la
  familia al core `docs_historical`, con su vector, y solo se busca en la vigente. Una versión
  más vieja que la vigente se rechaza: volver atrás se hace subiendo una versión posterior.
- Los PDF se convierten a markdown antes de subirlos; el PDF original puede subirse junto al
  `.md` para descargarlo después. `<!-- page: N -->` en el texto marca dónde empieza cada página.

Para cargar una carpeta sin pasar por el servidor:

```bash
docker compose up -d solr embed minio   # embed tarda un par de minutos en cargar el modelo
pnpm docs:load demo/documents           # 13 documentos (14 archivos) de una distribuidora inventada
```

| Ruta | Permiso | Para qué |
|---|---|---|
| `POST /docs` | `docs.manage` | Sube el `.md` (campo `document`) y opcionalmente el PDF (`original`); responde 202 con el trabajo encolado |
| `GET /docs/jobs/:id` | `docs.manage` | Estado del trabajo: `queued`, `running`, `done` (con los pedazos indexados) o `failed` (con el motivo) |
| `GET /docs` | `chat.use` | Documentos vigentes que puedo leer |
| `GET /docs/:code/original?kind=md\|pdf` | `chat.use` | Descarga el original de la versión vigente, si puedo leer su área |
| `POST /docs/:code/reindex` | `docs.manage` | Vuelve a indexar la versión vigente desde el `.md` guardado |
| `DELETE /docs/:code` | `docs.manage` | Retira la versión vigente de la búsqueda y borra sus originales; el histórico queda |

Los trabajos los procesa un worker dentro del servidor (`DOCS_WORKER_ENABLED`), de a uno. Con
varios servidores, el worker se deja encendido en uno solo.

### Cómo busca

Por palabras (con más peso en el código, el título y la sección) y por significado (vectores) en
paralelo, y fusiona ambas listas. Una pregunta que es exactamente un código devuelve ese
documento. Cada resultado se filtra por las áreas que la persona puede leer, también al pedir un
pasaje por su id. Si el servicio de vectores no responde, sigue solo con palabras.

El chat y los clientes externos tienen dos tools para esto, con los nombres que ChatGPT exige
para conectar una fuente de conocimiento:

- `search(query)`: hasta 10 pasajes con id, título y un fragmento.
- `fetch(id)`: el pasaje con la sección completa a la que pertenece (hasta ~12.000 caracteres),
  para que un paso nunca se lea sin sus condiciones.

`pnpm test:golden` mide, con el modelo real, si el documento que responde cada una de 30
preguntas sobre los documentos demo sale entre los tres primeros (hoy 30 de 30).

El esquema de Solr vive en `docker/solr/docs/conf/`. Los cores se crean con él la primera vez;
para aplicar un cambio de esquema hay que recrearlos (`docker compose down -v` borra los datos) y
volver a cargar los documentos.

## Fuentes de datos

Las tools leen bases de datos de la organización: SQL Server, MySQL o Postgres. Cada una se
registra una vez en `POST /admin/sources` (permiso `sources.manage`):

```json
{ "code": "erp", "name": "ERP", "engine": "mssql", "host": "erp.interno", "port": 1433,
  "database": "ventas", "username": "lector", "password": "…", "timeZone": "America/Guatemala",
  "tls": true }
```

- **Solo lectura**: al registrarla se revisa qué puede hacer el usuario, y si puede escribir
  (insertar, borrar, crear tablas, ser dueño de la base…) se rechaza con la lista de lo que
  puede. Además, en Postgres y MySQL cada consulta corre en una transacción de solo lectura.
- **Contraseña**: se guarda cifrada (AES-256-GCM, una llave por contraseña, cifrada a su vez con
  la llave maestra). La llave maestra es un archivo (`pnpm kek:generate` la crea en
  `secrets/kek.key`, `SECRETS_KEK_FILE`), nunca la base ni una variable de entorno: respáldala
  aparte, sin ella las contraseñas guardadas no se pueden leer. La API nunca devuelve una
  contraseña.
- **Zona horaria**: las fechas que la fuente guarda sin zona se leen tal cual, igual en los tres
  motores; `timeZone` de la fuente (o `APP_TIMEZONE` si no tiene) queda guardada para que el
  creador de tools las interprete.
- **Postgres 14 o anterior** da permiso de crear tablas en `public` a todos; ahí hay que
  revocarlo (`revoke create on schema public from public`) o el lector se rechaza.
- Registrar de nuevo un código existente lo reemplaza, verificándolo otra vez.

| Ruta | Para qué |
|---|---|
| `GET /admin/sources` | Las fuentes, sin contraseñas |
| `POST /admin/sources` | Registra o reemplaza una fuente, verificada |
| `POST /admin/sources/:code/test` | Vuelve a verificar conexión y solo lectura |
| `DELETE /admin/sources/:code` | La borra |

### Resultados grandes

Lo que devuelve una tool tiene un tope: 40 KB en el chat y las corridas de agentes, 250 KB para
clientes externos. Si no cabe, los totales quedan intactos, las listas se recortan y el detalle
completo, hasta 100.000 filas por lista, va a un Excel con un link firmado que vence a los 7
días (no pide login; quien reciba el link reenviado puede bajarlo mientras no venza). El Excel lo
escribe el código, nunca el modelo.

**Lo que devuelven las tools viaja al proveedor del modelo** (Anthropic, o el del cliente MCP)
como parte de la conversación. Registra solo fuentes cuyos datos puedan salir de tu red en esas
condiciones.

### Base demo

Una distribuidora inventada (clientes, productos, pedidos, detalle, entregas) igual en los tres
motores, con un usuario `demo_reader` de solo lectura:

```bash
docker compose --profile engines up -d demo-mysql demo-mssql   # demo-db (Postgres) ya está arriba
pnpm demo:seed                                                  # o solo: pnpm demo:seed postgres
```

## Licencia

[AGPL-3.0](LICENSE)
