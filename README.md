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
docker compose up -d   # postgres, solr, embed (bge-m3), minio, demo-db
pnpm dev               # http://localhost:3000/health
pnpm check             # typecheck + lint + tests
```

## Licencia

[AGPL-3.0](LICENSE)
