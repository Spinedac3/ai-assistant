---
description: Genera y publica la descripción de una pull request desde el diff real y el recibo
---

# /pr — descripción de la pull request

Un borrador completo leído del diff real; solo queda abierto lo que no se puede inferir.

## 1. Identificar la PR

Si vienes de `/implementar`, el repo, la rama y el issue ya se conocen, y el recibo está en
`docs/specs/<n>/recibo.json`: no se preguntan. Si la PR no existe se crea (`gh pr create`); si
existe, se actualiza (`gh pr edit`).

## 2. Leer el diff real

`git diff main...HEAD --stat`, y los archivos clave enteros: la ruta, la tool o el módulo
principal, la migración y todo archivo modificado de más de 30 líneas. De los tests basta el
nombre.

## 3. El borrador, inferido del diff

- **Qué entra**: qué hace, por módulo y archivo, con el detalle clave de cada uno.
- **Decisiones**: lo no obvio, cada una con qué se eligió y por qué; también la deuda que se deja a
  propósito.
- **Auditorías**: la tabla de hallazgos de calidad y seguridad con su severidad y cómo quedó, y lo
  que dejó la segunda revisión.
- **Validación**: cuántos tests (unitarios, integración, panel), los gates, los mutantes muertos
  sobre el total, y las pruebas reales con sus números. La validación manual de la persona es la
  ÚNICA casilla que queda `[ ]`.
- **Breaking changes**: rutas, esquemas de tools o columnas que cambian para quien ya los usa; si
  no hay, «Ninguno».
- **Cierre**: `Closes #N` solo en el repo dueño del issue; los demás citan `Implementa owner/repo#N`.

## 4. Plantilla

```markdown
## Qué entra
<qué hace; un punto por módulo, con el archivo>

### Decisiones
- **<qué se eligió>:** <por qué>

## Auditorías
| Hallazgo | Severidad | Estado |
|---|---|---|

## Validación
- [x] <N> tests vistos en rojo en `<sha>` y en verde en `<sha>`
- [x] Gates: typecheck, Biome, arquitectura
- [x] Mutantes: <muertos> de <total>
- [x] <pruebas reales, con números>
- [ ] Validación de la persona: <lo que recorre a mano>

## Recibo — <ESTADO> (`docs/specs/N/recibo.json`, certifica `<sha>`)
```json
<recibo tal cual>
```

Closes #<n>
```

## Reglas

- **No le pidas a la persona lo que ya está en el diff o pasó en la sesión.**
- Si ya dijo «push y PR» o «procede», se publica directo y se devuelve la URL; si no, una sola
  pregunta: «¿Publico?».
- Sin trailers de asistente ni menciones a quién lo escribió.
- **Si la persona corrige el flujo en el chat, la corrección se escribe en este archivo en el mismo
  turno.**
- Español, conciso.
