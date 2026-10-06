# CLAUDE.md — ai-assistant

TypeScript on Node 22, Fastify 5, Drizzle over Postgres, Solr + bge-m3 + MinIO for documents, a
React + Chakra panel in `web/`, vitest and Biome. A generic assistant: a headless chat that runs
every turn as `claude -p`, document search, a tool creator over registered SQL sources, all of it
served over MCP with OAuth 2.1. The README (Spanish) says how to run it; this file says how the
code is shaped.

It is a **modular monolith**, not layers: one folder per thing the assistant does, and a few
rules on who may import whom. The rules are tests in `tests/architecture/`, so breaking one fails
`pnpm test`.

Two different things get copied, and mixing them is the classic mistake:

- **Domain comes from the neighbourhood.** Open the files of the folder you touch before writing:
  what a source, a tool or a conversion is called there, which tables it reads.
- **Form comes from this document and from the exemplars below.** Not from whatever file sits
  next to your change: a neighbour can carry debt, and imitating it spreads it.

## The folders

| Folder | Owns |
|---|---|
| `auth/` | Accounts, passwords, JWT, OAuth codes and opaque tokens |
| `chat/` | One chat turn: the CLI run, its guards, conversations, quotas |
| `creator/` | Tools built from a definition: the SQL, the checks, the guide, the catalog prompts |
| `db/` | Our own schema, migrations and seed |
| `exports/` | Excel files of large results and their previews |
| `lib/` | Helpers with no knowledge of the rest: PDF parts, hidden text, model answers |
| `llm/` | The Claude CLI: the only place that starts it |
| `mcp/` | The MCP server, the capability catalog and what each caller sees |
| `notices/` | Mail and the outbox of `send_notice` |
| `permissions/` | Resolving the scopes of a person |
| `rag/` | Documents: upload, conversion from PDF, indexing, search |
| `routes/` | The HTTP surface; composes everything else |
| `sources/` | The databases a person registers, read-only, one driver per engine |
| `tools/` | The registry, the size cap with its Excel, the native tools |
| `usage/` | Usage counts |
| `vault/` | Encryption of source passwords |

## The pieces

Copy the form of the exemplar; `tests/architecture/pieces.test.ts` scores every candidate and
fails when the exemplar named here stops scoring best. The criteria live in
`tests/architecture/support/pieces.ts`.

| Piece | Exemplar | What makes it one |
|---|---|---|
| Native tool | `src/tools/native/readPdf.ts` | Its own test, exported snake_case name, `additionalProperties: false`, failures as `{ ok: false, error, message }` |
| Route module | `src/routes/sources.ts` | Its own integration test, a permission on every route, bodies through `safeParse`, errors as `{ ok, error, message }` |
| Model call | `src/creator/catalog.ts` | Its own test, data passed with `promptData`, the answer read with `jsonIn` / `answerText` |

## Direction rules

Each one is a test in `tests/architecture/layers.test.ts`.

1. **`lib/`, `config/` and `vault/` import nothing from the application**, nor from each other.
2. **`db/` borrows only types** (`import type`), to describe its json columns.
3. **Routes, plugins and the app are composed from above**: nothing under them imports them.
4. **`permissions/` decides, it never serves**: it imports only `db/`, `lib/` and `config/`.
5. **`sources/` stands on `db/`, `vault/`, `lib/` and `config/` alone.**
6. **A database driver is imported only in `sources/`, `db/` and `cli/`.** A tool reads a source
   through `sources/`, never through a driver.
7. **A subprocess starts only in `llm/`** and in the composition root (`index.ts`, for
   `claude --version`).

## Rules that protect the people using it

- **Nothing a person or a model wrote goes in a subprocess's argv.** The prompt goes by stdin;
  the arguments are flags this code wrote. The CLI gets an allow-list of tools, and Read reaches
  only the files of that call.
- **Data from a database, a document or a person goes to a model as data**: through `promptData`
  (`src/lib/hiddenText.ts`), never pasted into the instructions. **What a model answers is read as
  untrusted**: `jsonIn` and `answerText` (`src/lib/modelAnswer.ts`) take it apart, and every field
  is checked before it is used.
- **Tool results reach the model wrapped as untrusted data.**
- **Credentials live in files** (`secrets/`), never in environment variables.
- **No tool cuts rows to protect the model.** The only bound is by size in the registry
  (`src/tools/cap.ts`), which keeps the whole detail as an Excel. Every bound a tool's input
  declares is listed with its reason in `tests/architecture/caps.test.ts`; a list of people takes
  at least two hundred.

## Silent traps

1. **The CLI resumes its own session by id** (`--resume <id>` stored in the conversation's
   workspace), never `--continue`: the latest session of a folder may be someone else's.
2. **The CLI reads a PDF whole or not at all**: reading pages needs a renderer the server does not
   have. Long PDFs are split with `pdf-lib` into parts of ten pages (`src/lib/pdf.ts`).
3. **`pdf-lib` opens almost anything**, even a file of garbage with no pages: `openPdf` refuses a
   document with zero pages.
4. **Biome turns a Unicode escape into the invisible character itself.** Build such characters
   with `String.fromCodePoint(...)`.
5. **Shell edits break backslashes** (`sed`, `node -e`, heredocs): edit escapes with the editor.
6. **Solr cores take their schema when created**: a schema change means recreating them and
   loading the documents again.
7. **Integration tests need the services** (`docker compose --profile engines up -d`); golden
   tests also need the real embedding model.

## Style

- Identifiers and comments in **English**; whatever a person reads at runtime in **Spanish**
  (messages, errors, assertion messages, the panel).
- A docblock on every function, **its description in one paragraph**, `@param` and `@return`
  aligned in columns:
  ```ts
  /**
   * Reads the exemplar the guide names for each piece
   *
   * @param   guide  The guide's text
   *
   * @return  Each piece with its exemplar
   */
  ```
  The why goes in a `//` comment where it applies, at the top of the body when it is about the
  whole function.
- Comments explain **why**, and never cite a date, an issue, a decision number, a person or a
  pending task: those live in the pull request.
- No over-engineering: no abstraction with one user, no option nobody asked for, no copy of a
  helper that already exists in `lib/`.
- Files in camelCase, components in PascalCase; native tools in snake_case.
- Tests: one behaviour each, named as a sentence, with `// Performs the test.` and
  `// Performs assertions.`
- Commits: `:gitmoji: Short subject` in English, no assistant trailers. The hook in
  `tools/harness/commit-msg.sh` checks it; install it once per clone (one line in its header).

## The flow

A change starts as an issue and ends as a pull request with its receipt:

1. `/grill` — the design questions, one at a time, each with a recommended answer; the spec goes
   in the issue.
2. `bash tools/harness/spec-dump.sh <owner/repo> <n>` — the issue as it is today, in
   `docs/specs/<n>/issue.md`.
3. `/implementar <n>` — tests first: `bash tools/harness/recibo.sh rojo ...` must see them fail,
   then the code, then `recibo.sh verde ...` writes `docs/specs/<n>/recibo.json`.
4. `/pr` — the pull request with the receipt and the audits.

## Before you finish

```
pnpm check              # typecheck, Biome and the unit tests, architecture gates included
pnpm test:integration   # against the real services
```

Then a quality and a security review of `git diff main..HEAD`, a test for every finding, and the
mutants of the critical changes: a check that has never been seen failing proves nothing.

## Three ways a document like this goes wrong

1. **A rule written from impression instead of counted against the tree.** Every rule above is a
   test that measures the tree.
2. **A check that returns zero is worth nothing until it has been seen returning one.** Every
   gate in `tests/architecture/` is fed a breach of each of its rules.
3. **An agent's own report is not evidence.** Run the gates yourself and read the diff.
