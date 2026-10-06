# Glosario

Qué es cada palabra del dominio en el código, y qué homónimo **no** es. Es un mapa, no una
fuente: antes de decidir sobre una palabra, la evidencia sigue siendo la tabla o el archivo. Cuando
un grill o una implementación resuelve una palabra nueva, la fila entra aquí en esa misma PR.

| Palabra | Es | NO es |
|---|---|---|
| **fuente** | Una base de datos que alguien registra para leer, solo lectura, con su motor y su zona horaria (`sources`, `src/sources/`) | Nuestra propia base (`src/db/`), que nunca se ofrece como fuente |
| **herramienta** (tool) | Algo que un modelo puede llamar: una nativa (`src/tools/native/`) o una creada sobre una fuente (`tool_definitions`, `src/creator/`) | Una capacidad del catálogo: la herramienta es lo que corre, la capacidad es cómo se la encuentra |
| **capacidad** | Una herramienta tal como la ven el chat y los clientes externos, que la buscan con `find_capability` y la corren con `run_capability` (`src/mcp/`) | Un permiso: ver una capacidad no habilita correrla |
| **definición** | Lo que guarda el creador de una herramienta: columnas, filtros, resúmenes y textos para el modelo (`tool_definitions.spec`) | La herramienta publicada: una definición puede estar en borrador |
| **área** | El grupo de documentos que lee un permiso `docs.<área>.read` | Una carpeta o un departamento de la organización |
| **documento** | Un texto en Markdown con su encabezado, indexado por fragmentos, y su original si lo tiene (`src/rag/`) | Un PDF del chat, que se lee una vez y no se indexa |
| **familia** y **versión** | Los documentos con el mismo código sin la versión; solo la versión más alta se busca | Una revisión, que es un campo del encabezado y no cambia la familia |
| **conversión** | Un PDF que la IA pasa a Markdown para revisar antes de publicarlo (`pdf_conversions`) | Un trabajo de indexación (`document_jobs`), que llega después de publicar |
| **permiso** (scope) | Un código como `tools.manage` o `sources.demo.use`, que llega por rol o como extra de la persona (`scopes`) | Un rol, que agrupa permisos |
| **aviso** | Un correo que pide `send_notice`, con su llave para no repetirse, y que la cola reintenta (`notices`) | Un mensaje del chat |
| **cuenta de servicio** | Una cuenta que usa un sistema y no una persona; su uso se cuenta aparte | Un cliente OAuth (`oauth_clients`), que es la aplicación por la que entra alguien |
| **resultado grande** | El resultado de una herramienta que pasa el tamaño que acepta quien lo lee: se acorta y el detalle completo viaja como Excel (`export_files`) | Un error: nada se pierde, el Excel lo trae todo |
