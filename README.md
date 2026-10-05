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
docker compose up -d postgres   # el resto de servicios entra con su rebanada
pnpm keys:generate              # llave RS256 en secrets/, nunca en variables
pnpm db:migrate
pnpm admin:create --email tu@empresa.com --name "Tu Nombre"
pnpm dev                        # http://localhost:3000/health
pnpm check                      # typecheck + lint + tests unitarios
pnpm test:integration           # también los que usan Postgres
```

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
| El chat del asistente | `find_capability` y `run_capability`: descubre la herramienta con su esquema y la ejecuta |
| Un cliente externo (Claude, ChatGPT…) | Lo mismo, más un parámetro `original_question` que se guarda 90 días para mejorar el catálogo |
| La corrida de un agente | Solo sus herramientas, directas, con su esquema de salida |

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

## Licencia

[AGPL-3.0](LICENSE)
