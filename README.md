# ai-assistant

> **In English:** a generic AI assistant — chat, document search (RAG) and a declarative SQL tool
> builder — served over MCP. Work in progress.

Asistente de IA genérico: chat, búsqueda en documentos (RAG) y un creador de tools sobre SQL
declarativo, expuesto por MCP para que cualquier cliente lo use. Su pareja es
[agent-factory](https://github.com/Spinedac3/agent-factory), que arma agentes programados sobre
estas tools.

**En construcción.** Este README crece con cada rebanada.

## Cómo se corre

Necesitás Node 22, pnpm y Docker.

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

## Licencia

[AGPL-3.0](LICENSE)
