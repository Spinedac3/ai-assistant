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

En Windows, `CLAUDE_BIN` tiene que apuntar al `claude.exe` real: Node no ejecuta el
`claude.cmd` sin una shell.

## Licencia

[AGPL-3.0](LICENSE)
