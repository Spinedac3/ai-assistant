import {
  Badge,
  Box,
  Button,
  Checkbox,
  Field,
  Flex,
  Heading,
  HStack,
  IconButton,
  Input,
  NativeSelect,
  SegmentGroup,
  Spinner,
  Stack,
  Switch,
  Text,
  Textarea,
} from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { FiCheck, FiMinus, FiPlus, FiTrash2, FiX } from "react-icons/fi";
import { useLocation, useNavigate, useParams } from "react-router";
import { ApiError, api } from "../api/http";
import { useSession } from "../api/session";
import { TimeZoneSelect } from "../shell/TimeZoneSelect";
import { ToolLab } from "./ToolLab";
import {
  AGGREGATE_LABELS,
  AGGREGATES,
  type BaseColumn,
  blankDefinition,
  CHECK_LABELS,
  type CheckResult,
  type ColumnKind,
  cleanDefinition,
  type Definition,
  type DescribedBase,
  FILTER_OPS,
  type FilterHelp,
  type FilterOp,
  OP_LABELS,
  outputNames,
  prune,
  type Relation,
  type ToolDetail,
  type TotalsIdea,
  VALUE_OPS,
  withDefaults,
} from "./types";

const NAME = /^[a-z][a-z0-9_]{2,63}$/;
// The creator's steps, in the order a person walks them
const STEPS = [
  "Fuente",
  "Tabla o vista",
  "Columnas",
  "Filtros",
  "Totales y orden",
  "Nombre y descripción",
  "Guardar y publicar",
];
const KIND_LABELS: Record<ColumnKind, string> = {
  number: "número",
  text: "texto",
  date: "fecha",
  datetime: "fecha y hora",
  boolean: "sí o no",
};
export const NEW_TOOL = "_nueva";

/**
 * Opens the editor fresh for each tool, so nothing of one is left in another
 *
 * @return  The page
 */
export function ToolEditorRoute() {
  const { name } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const carried = (location.state as { checks?: CheckResult[] } | null)?.checks ?? null;
  // The checks travel once: a reload or a step back must not show those of another version
  useEffect(() => {
    if (location.state) {
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location, navigate]);
  // A tool name starts with a letter, so this path never names one
  return (
    <ToolEditor
      key={name}
      initialName={name === NEW_TOOL ? null : (name ?? null)}
      initialChecks={carried}
    />
  );
}

/**
 * The creator of a tool: what it reads, which columns it returns, how a person filters and sums
 * them, and what its data means, with the checks of each saved version and the lab beside it
 *
 * @param   props  The tool being edited, or null for a new one
 *
 * @return  The page
 */
function ToolEditor({
  initialName,
  initialChecks,
}: {
  initialName: string | null;
  initialChecks: CheckResult[] | null;
}) {
  const navigate = useNavigate();
  const queries = useQueryClient();
  const session = useSession();
  // The sources a person may build on are the ones whose permission they hold
  const sources = (session?.user.scopes ?? [])
    .map((scope) => scope.match(/^sources\.(.+)\.use$/)?.[1])
    .filter((code): code is string => Boolean(code));

  const [name, setName] = useState(initialName ?? "");
  const [source, setSource] = useState(sources[0] ?? "");
  const [definition, setDefinition] = useState<Definition>(blankDefinition());
  const [baseColumns, setBaseColumns] = useState<BaseColumn[]>([]);
  const [checks, setChecks] = useState<CheckResult[] | null>(initialChecks);
  const [status, setStatus] = useState<"draft" | "published" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const saved = useQuery({
    queryKey: ["tool", initialName],
    queryFn: () => api<ToolDetail>(`/admin/tools/${initialName}`),
    enabled: initialName !== null,
  });
  // The form takes the saved tool once; a later read never replaces what the person is editing
  const [loaded, setLoaded] = useState(initialName === null);
  // What the server holds, to tell whether the form has changes not saved yet
  const [savedAs, setSavedAs] = useState<string | null>(null);
  useEffect(() => {
    if (saved.data && !loaded) {
      const stored = withDefaults(saved.data.definition);
      setSource(saved.data.source);
      setDefinition(stored);
      setBaseColumns(saved.data.columns);
      setStatus(saved.data.status);
      setSavedAs(JSON.stringify(cleanDefinition(stored)));
      setLoaded(true);
    }
  }, [saved.data, loaded]);

  // One step at a time for a new tool; a saved one opens at its review, any step a click away
  const [step, setStep] = useState(initialName === null ? 0 : STEPS.length - 1);
  // A pasted query is for whoever writes SQL; everyone else picks a table or a view
  const [advanced, setAdvanced] = useState(false);
  const [search, setSearch] = useState("");
  // Why the model could not describe the base, when it could not
  const [note, setNote] = useState<string | null>(null);
  const isNew = initialName === null;
  // The folded options of the last step, and the trial beside a saved tool
  const [more, setMore] = useState(false);
  const [trying, setTrying] = useState(false);
  const [suggested, setSuggested] = useState(false);
  // Columns whose values are being read for their filter
  const [helping, setHelping] = useState<string[]>([]);
  // The description last filled in for the person, replaced when they pick another base
  const [autoDescription, setAutoDescription] = useState<string | null>(null);
  const relations = useQuery({
    queryKey: ["relations", source],
    queryFn: () =>
      api<{ relations: Relation[] }>(`/admin/tools/relations?source=${encodeURIComponent(source)}`),
    enabled: source !== "" && step === 1,
  });
  useEffect(() => {
    if (saved.data) {
      setAdvanced(saved.data.definition.base.kind === "query");
    }
  }, [saved.data]);

  /**
   * Has the model write what the tool returns, what a row is, its name and other ways to ask for
   * it, from everything built so far; what the person wrote stays unless they ask for it again
   *
   * @param   redo  Whether to replace what is already written
   */
  const suggestMeaning = (redo: boolean) => {
    setBusy("suggest");
    const about = (autoDescription ?? definition.meaning.definition).trim();
    const summary = definition.summary;
    api<{
      name: string | null;
      definition: string | null;
      grain: string | null;
      synonyms: string[];
    }>("/admin/tools/suggest", {
      method: "POST",
      body: {
        about: about || "Sin descripción",
        columns: definition.columns.map((column) => column.name),
        filters: definition.filters.map((filter) => filter.column),
        totals: summary
          ? {
              by: summary.group_by,
              calculations: summary.aggregates.map((aggregate) =>
                aggregate.fn === "count"
                  ? `${aggregate.as}: cantidad de filas`
                  : `${aggregate.as}: ${AGGREGATE_LABELS[aggregate.fn].toLowerCase()} de ${aggregate.column}`,
              ),
              detail: summary.with_detail === true,
            }
          : null,
      },
    })
      .then((suggestion) => {
        if (suggestion.name && isNew) {
          setName((current) => (redo || !current ? (suggestion.name ?? current) : current));
        }
        setDefinition((current) => {
          // The base's own description is only a start; the model's says what the tool returns
          const written =
            current.meaning.definition.trim() !== "" &&
            current.meaning.definition !== autoDescription;
          return {
            ...current,
            meaning: {
              ...current.meaning,
              definition:
                suggestion.definition && (redo || !written)
                  ? suggestion.definition
                  : current.meaning.definition,
              grain:
                suggestion.grain && (redo || !current.meaning.grain)
                  ? suggestion.grain
                  : current.meaning.grain,
              synonyms:
                redo || current.meaning.synonyms.length === 0
                  ? suggestion.synonyms
                  : current.meaning.synonyms,
            },
          };
        });
      })
      // Without a suggestion the person writes them; nothing else depends on it
      .catch(() => undefined)
      .finally(() => setBusy(null));
  };

  // Summaries the model proposes for the base, asked once when the totals step opens
  const [ideas, setIdeas] = useState<TotalsIdea[]>([]);
  const [ideasAsked, setIdeasAsked] = useState(false);
  const [ideasLoading, setIdeasLoading] = useState(false);
  // The idea in use leaves the list, so what remains are the ones still to choose from
  const [appliedIdea, setAppliedIdea] = useState<string | null>(null);
  const [usedIdeas, setUsedIdeas] = useState<string[]>([]);
  useEffect(() => {
    if (step !== 4 || ideasAsked || baseColumns.length === 0) {
      return;
    }
    setIdeasAsked(true);
    setIdeasLoading(true);
    api<{ ideas: TotalsIdea[] }>("/admin/tools/suggest-totals", {
      method: "POST",
      body: {
        source,
        base: definition.base,
        about: (autoDescription ?? definition.meaning.definition).trim() || undefined,
      },
    })
      .then((answer) => setIdeas(answer.ideas))
      // Without ideas the person builds the summary by hand
      .catch(() => undefined)
      .finally(() => setIdeasLoading(false));
  });

  /**
   * Takes one of the model's summaries: its groups and measures, the columns they need, and the
   * first measure as the order, largest first
   *
   * @param   idea  Summary proposed
   */
  const applyIdea = (idea: TotalsIdea) => {
    setAppliedIdea(idea.label);
    setUsedIdeas((current) => [...current, idea.label]);
    const needed = [
      ...idea.group_by,
      ...idea.aggregates.flatMap((aggregate) => (aggregate.column ? [aggregate.column] : [])),
    ];
    const missing = [...new Set(needed)].filter(
      (column) => !definition.columns.some((chosen) => chosen.name === column),
    );
    change({
      columns: [...definition.columns, ...missing.map((name) => ({ name }))],
      summary: {
        group_by: idea.group_by,
        aggregates: idea.aggregates,
        with_detail: definition.summary?.with_detail ?? true,
      },
      order_by: idea.aggregates[0] ? [{ column: idea.aggregates[0].as, direction: "desc" }] : [],
    });
  };

  // The meaning is written once, when the last step opens; the person can ask for it again
  useEffect(() => {
    if (step === 5 && !suggested && definition.columns.length > 0) {
      setSuggested(true);
      suggestMeaning(false);
    }
  });

  // Every change drops what no longer fits, so what the form shows is what gets saved
  const change = (patch: Partial<Definition>) =>
    setDefinition((current) => prune({ ...current, ...patch }, baseColumns));
  const guard = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "No se pudo completar");
    } finally {
      setBusy(null);
    }
  };

  /**
   * Takes what a base holds: its columns, and its description as what the tool returns unless
   * the person already wrote their own
   *
   * @param   base       Base that was read
   * @param   described  Its columns and description
   */
  const takeBase = (base: Definition["base"], described: DescribedBase) => {
    setBaseColumns(described.columns);
    setNote(described.note ?? null);
    const names = new Set(described.columns.map((column) => column.name));
    setDefinition((current) => {
      // Reading the same base again keeps the choices that still exist; another one takes them all
      const same = JSON.stringify(current.base) === JSON.stringify(base);
      const kept = same ? current.columns.filter((column) => names.has(column.name)) : [];
      const own =
        current.meaning.definition.trim() !== "" && current.meaning.definition !== autoDescription;
      return prune(
        {
          ...current,
          base,
          columns:
            kept.length > 0 ? kept : described.columns.map((column) => ({ name: column.name })),
          meaning:
            described.description && !own
              ? { ...current.meaning, definition: described.description }
              : current.meaning,
        },
        described.columns,
      );
    });
    setAutoDescription(described.description);
  };

  // A table with a comment in the database is described by it; any other base, by the model
  const pickTable = (relation: Relation) =>
    guard("columns", async () => {
      const base = { kind: "table" as const, name: relation.name };
      const described = relation.comment
        ? {
            ...(await api<{ columns: BaseColumn[] }>("/admin/tools/describe", {
              method: "POST",
              body: { source, base },
            })),
            description: relation.comment,
          }
        : await api<DescribedBase>("/admin/tools/explain", {
            method: "POST",
            body: { source, base },
          });
      takeBase(base, described);
    });

  const readQuery = () =>
    guard("columns", async () => {
      const base = definition.base;
      takeBase(
        base,
        await api<DescribedBase>("/admin/tools/explain", {
          method: "POST",
          body: { source, base },
        }),
      );
    });

  const save = () =>
    guard("save", async () => {
      const sent = cleanDefinition(definition);
      const data = await api<{ status: "draft"; checks: CheckResult[]; columns: BaseColumn[] }>(
        `/admin/tools/${name}`,
        // A new tool never replaces another of the same name
        { method: "PUT", body: { source, definition: sent, create: savedAs === null } },
      );
      setChecks(data.checks);
      setStatus(data.status);
      setBaseColumns(data.columns);
      setSavedAs(JSON.stringify(sent));
      await queries.invalidateQueries({ queryKey: ["tools"] });
      await queries.invalidateQueries({ queryKey: ["tool", name] });
      if (initialName !== name) {
        // The page of the saved tool opens fresh; its checks travel with it
        navigate(`/herramientas/${name}`, { replace: true, state: { checks: data.checks } });
      }
    });

  const publish = () =>
    guard("publish", async () => {
      try {
        const data = await api<{ status: "published"; checks: CheckResult[] }>(
          `/admin/tools/${name}/publish`,
          { method: "POST" },
        );
        setChecks(data.checks);
        setStatus(data.status);
        await queries.invalidateQueries({ queryKey: ["tools"] });
      } catch (failure) {
        // The server runs the checks again; when they fail, those are the ones to show
        const failed = (failure as ApiError).details as { checks?: CheckResult[] } | undefined;
        if (failed?.checks) {
          setChecks(failed.checks);
        }
        throw failure;
      }
    });

  const remove = () =>
    guard("delete", async () => {
      if (!window.confirm(`¿Borrar la herramienta ${name}? Deja de estar disponible para todos.`)) {
        return;
      }
      await api(`/admin/tools/${name}`, { method: "DELETE" });
      queries.removeQueries({ queryKey: ["tool", name] });
      await queries.invalidateQueries({ queryKey: ["tools"] });
      navigate("/herramientas");
    });

  if (initialName && saved.isLoading) {
    return <Spinner color="brand.solid" />;
  }
  if (initialName && saved.isError) {
    return (
      <Text role="alert" color="fg.error">
        {saved.error instanceof ApiError && saved.error.code === "tool_not_found"
          ? "Esa herramienta no existe, o es de una fuente que no puedes usar."
          : "No se pudo abrir la herramienta; vuelve a intentarlo."}
      </Text>
    );
  }
  const chosen = definition.columns.map((column) => column.name);
  const kindOf = (column: string) => baseColumns.find((base) => base.name === column)?.kind;
  // What each step needs before the next one opens
  const ready = [
    source !== "",
    baseColumns.length > 0,
    definition.columns.length > 0,
    true,
    (definition.summary?.aggregates ?? []).every(
      (aggregate) => aggregate.as !== "" && (aggregate.fn === "count" || aggregate.column),
    ),
    NAME.test(name) && definition.meaning.definition.trim() !== "",
  ];
  const reachable = (index: number) => ready.slice(0, index).every(Boolean);
  const canSave = ready.every(Boolean);
  const dirty = JSON.stringify(cleanDefinition(definition)) !== savedAs;
  // The server checks again before publishing; what matters here is that what is shown is saved
  const canPublish = savedAs !== null && !dirty && status === "draft";

  const words = search.trim().toLowerCase();
  const offered = (relations.data?.relations ?? []).filter(
    (relation) =>
      words === "" ||
      relation.name.toLowerCase().includes(words) ||
      (relation.comment ?? "").toLowerCase().includes(words),
  );
  // Ideas for the filters a person most often asks for, over the columns this base has
  const filtered = new Set(definition.filters.map((filter) => filter.column));
  const dateIdea = baseColumns.find(
    (column) =>
      (column.kind === "date" || column.kind === "datetime") && !filtered.has(column.name),
  );
  const textIdeas = baseColumns
    .filter((column) => column.kind === "text" && !filtered.has(column.name))
    .slice(0, 3);
  // The next column without a filter, for a new one
  const nextColumn = baseColumns.find((column) => !filtered.has(column.name));

  /**
   * Reads a filter's real values and has the model explain it; an explanation the person already
   * wrote stays unless they ask for a new one
   *
   * @param   column  Column of the filter
   * @param   op      Its operator
   * @param   redo    Whether to replace the explanation already there
   */
  const helpFilter = async (column: string, op: FilterOp, redo = false) => {
    setHelping((current) => [...current, column]);
    try {
      const help = await api<FilterHelp>("/admin/tools/filter-help", {
        method: "POST",
        body: {
          source,
          base: definition.base,
          column,
          op,
          about: definition.meaning.definition.trim() || undefined,
        },
      });
      setNote(help.note ?? null);
      setDefinition((current) => ({
        ...current,
        filters: current.filters.map((filter) =>
          filter.column !== column
            ? filter
            : {
                ...filter,
                // What the person wrote of a value that is still there stays with it
                values: help.values?.map((value) => ({
                  value,
                  meaning: filter.values?.find((item) => item.value === value)?.meaning,
                })),
                examples: help.examples ?? undefined,
                description:
                  redo || !filter.description?.trim()
                    ? (help.description ?? filter.description)
                    : filter.description,
              },
        ),
      }));
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "No se pudieron leer los valores");
    } finally {
      setHelping((current) => current.filter((item) => item !== column));
    }
  };

  const shownIdeas = ideas.filter((idea) => !usedIdeas.includes(idea.label));
  const inUse = definition.summary ? appliedIdea : null;
  // An order names each column once, so the next one offered is one not ordered yet
  const ordered = new Set(definition.order_by.map((order) => order.column));
  const nextOrder = outputNames(definition).find((column) => !ordered.has(column));

  const addFilter = (filter: Definition["filters"][number]) => {
    change({ filters: [...definition.filters, filter] });
    void helpFilter(filter.column, filter.op);
  };

  return (
    <Flex gap={4} align="start" direction={{ base: "column", xl: "row" }}>
      {/* Nothing changes while a version is being saved and checked */}
      <fieldset
        disabled={busy === "save"}
        style={{ flex: 1, minWidth: 0, border: 0, padding: 0, margin: 0, width: "100%" }}
      >
        <Stack gap={4}>
          <HStack gap={1} wrap="wrap">
            {STEPS.map((label, index) => (
              <Button
                key={label}
                size="xs"
                variant={index === step ? "solid" : "ghost"}
                colorPalette={index === step ? "brand" : "gray"}
                disabled={!reachable(index)}
                onClick={() => setStep(index)}
              >
                {index !== step && reachable(index + 1) ? <FiCheck /> : `${index + 1}.`} {label}
              </Button>
            ))}
            {status && (
              <Badge
                ms="auto"
                variant="subtle"
                colorPalette={status === "published" ? "green" : "gray"}
              >
                {status === "published" ? "Publicada" : "Borrador"}
              </Badge>
            )}
          </HStack>

          {step === 0 && (
            <Section
              title="¿De qué base de datos lee?"
              hint="La herramienta lee de una fuente registrada en «Fuentes». Solo aparecen las que tienes permiso de usar."
            >
              <Field.Root required maxW="sm">
                <Field.Label>Fuente</Field.Label>
                <NativeSelect.Root disabled={!isNew}>
                  <NativeSelect.Field
                    value={source}
                    onChange={(event) => {
                      setSource(event.target.value);
                      // Another source has other tables: what was picked no longer applies
                      setBaseColumns([]);
                      setDefinition(blankDefinition());
                      setAutoDescription(null);
                    }}
                  >
                    {sources.length === 0 && <option value="">No tienes fuentes</option>}
                    {sources.map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
                {!isNew && (
                  <Field.HelperText>
                    La fuente de una herramienta guardada no cambia.
                  </Field.HelperText>
                )}
              </Field.Root>
              {sources.length === 0 && (
                <Text fontSize="sm" color="fg.muted" mt={3}>
                  Todavía no tienes fuentes: regístrala en «Fuentes» o pide el permiso a quien
                  administra el asistente.
                </Text>
              )}
            </Section>
          )}

          {step === 1 && (
            <Section
              title="¿Qué lee?"
              hint={
                advanced
                  ? "Escribe una consulta SELECT para unir tablas o calcular columnas. Sin ORDER BY: el orden se elige en «Totales y orden»."
                  : "Estas son las tablas y vistas que la fuente deja leer. Elige una para ver qué guarda y sus columnas."
              }
            >
              <SegmentGroup.Root
                size="sm"
                mb={3}
                value={advanced ? "query" : "table"}
                onValueChange={(details) => {
                  const query = details.value === "query";
                  if (query === advanced) {
                    return;
                  }
                  setAdvanced(query);
                  setBaseColumns([]);
                  change({
                    base: query ? { kind: "query", sql: "" } : { kind: "table", name: "" },
                  });
                }}
              >
                <SegmentGroup.Indicator />
                <SegmentGroup.Items
                  items={[
                    { value: "table", label: "Elegir una tabla o vista" },
                    { value: "query", label: "Escribir una consulta (avanzado)" },
                  ]}
                />
              </SegmentGroup.Root>
              {!advanced ? (
                <Stack gap={3}>
                  <Input
                    placeholder="Buscar por nombre o descripción"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                  {relations.isLoading ? (
                    <Spinner color="brand.solid" />
                  ) : relations.isError ? (
                    <Text role="alert" color="fg.error" fontSize="sm">
                      {relations.error instanceof ApiError
                        ? relations.error.message
                        : "No se pudieron leer las tablas de la fuente"}
                    </Text>
                  ) : (
                    <Stack gap={2} maxH="96" overflowY="auto">
                      {offered.length === 0 && (
                        <Text fontSize="sm" color="fg.muted">
                          Nada coincide con la búsqueda.
                        </Text>
                      )}
                      {offered.map((relation) => {
                        const picked =
                          definition.base.kind === "table" &&
                          definition.base.name === relation.name;
                        return (
                          <Box
                            key={relation.name}
                            as="button"
                            textAlign="start"
                            p={3}
                            borderWidth="1px"
                            rounded="md"
                            borderColor={picked ? "brand.solid" : "border"}
                            bg={picked ? "bg.muted" : undefined}
                            _hover={{ bg: "bg.muted" }}
                            cursor="pointer"
                            onClick={() => void pickTable(relation)}
                          >
                            <HStack gap={2}>
                              <Text fontFamily="mono" fontWeight="medium" fontSize="sm">
                                {relation.name}
                              </Text>
                              <Badge size="sm" variant="subtle">
                                {relation.kind === "view" ? "vista" : "tabla"}
                              </Badge>
                              {picked && <FiCheck />}
                            </HStack>
                            <Text fontSize="sm" color="fg.muted">
                              {relation.comment ??
                                "Sin descripción en la base; al elegirla la escribe el asistente."}
                            </Text>
                          </Box>
                        );
                      })}
                    </Stack>
                  )}
                </Stack>
              ) : (
                <Stack gap={3}>
                  <Textarea
                    fontFamily="mono"
                    fontSize="sm"
                    rows={6}
                    placeholder="select p.fecha, p.total, c.zona from pedidos p join clientes c on c.id = p.cliente_id"
                    value={definition.base.kind === "query" ? definition.base.sql : ""}
                    onChange={(event) =>
                      change({ base: { kind: "query", sql: event.target.value } })
                    }
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    alignSelf="start"
                    loading={busy === "columns"}
                    disabled={definition.base.kind !== "query" || !definition.base.sql.trim()}
                    onClick={() => void readQuery()}
                  >
                    Leer columnas
                  </Button>
                </Stack>
              )}
            </Section>
          )}
          {step === 1 && busy === "columns" && (
            <HStack gap={2}>
              <Spinner size="sm" color="brand.solid" />
              <Text fontSize="sm" color="fg.muted">
                Leyendo la tabla y escribiendo qué guarda…
              </Text>
            </HStack>
          )}
          {step === 1 && baseColumns.length > 0 && busy !== "columns" && (
            <Section
              title="Qué guarda"
              hint="Puedes corregir la descripción: será lo que la herramienta dice que devuelve."
            >
              <Textarea
                rows={3}
                value={definition.meaning.definition}
                onChange={(event) =>
                  change({ meaning: { ...definition.meaning, definition: event.target.value } })
                }
              />
              {note && (
                <Text fontSize="sm" color="fg.muted" mt={2}>
                  {note}
                </Text>
              )}
              <Text fontSize="sm" color="fg.muted" mt={3} mb={2}>
                Sus columnas ({baseColumns.length})
              </Text>
              <HStack wrap="wrap" gap={2}>
                {baseColumns.map((column) => (
                  <Badge key={column.name} variant="outline" fontFamily="mono">
                    {column.name} · {KIND_LABELS[column.kind]}
                  </Badge>
                ))}
              </HStack>
            </Section>
          )}

          {step === 2 && (
            <Section
              title="Qué columnas devuelve"
              hint="Marca lo que la persona necesita ver en la respuesta. La etiqueta es como se le dice en el día a día, por ejemplo «Fecha de entrega» para entregado_en."
            >
              <Stack gap={1}>
                {baseColumns.map((column) => {
                  const picked = definition.columns.find((item) => item.name === column.name);
                  return (
                    <HStack key={column.name} gap={3}>
                      <Checkbox.Root
                        checked={picked !== undefined}
                        onCheckedChange={(details) =>
                          change({
                            columns: details.checked
                              ? [...definition.columns, { name: column.name }]
                              : definition.columns.filter((item) => item.name !== column.name),
                          })
                        }
                        minW="56"
                      >
                        <Checkbox.HiddenInput />
                        <Checkbox.Control />
                        <Checkbox.Label fontFamily="mono" fontSize="sm">
                          {column.name}
                        </Checkbox.Label>
                      </Checkbox.Root>
                      <Badge variant="outline" size="sm">
                        {KIND_LABELS[column.kind]}
                      </Badge>
                    </HStack>
                  );
                })}
              </Stack>
            </Section>
          )}

          {step === 3 && (dateIdea || textIdeas.length > 0) && (
            <Section
              title="Ideas para empezar"
              hint="Un clic agrega el filtro; después lo ajustas abajo."
            >
              <HStack wrap="wrap" gap={2}>
                {dateIdea && (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      addFilter({
                        column: dateIdea.name,
                        op: "between",
                        required: false,
                      })
                    }
                  >
                    <FiPlus /> Pedir un rango de {dateIdea.name}
                  </Button>
                )}
                {textIdeas.map((column) => (
                  <Button
                    key={column.name}
                    size="xs"
                    variant="outline"
                    onClick={() => addFilter({ column: column.name, op: "=", required: false })}
                  >
                    <FiPlus /> Pedir un {column.name} en particular
                  </Button>
                ))}
              </HStack>
            </Section>
          )}
          {step === 3 && (
            <Section
              title="Por qué se puede filtrar"
              hint="Cada filtro es algo que la persona podrá pedir al preguntar, como un rango de fechas o una zona. Al agregarlo, el asistente lee los valores reales de la columna y redacta cómo debe usarlo la IA; revísalo y ajústalo. Marca obligatorio el que siempre debe venir, para no traer la tabla entera."
            >
              <Stack gap={3}>
                {definition.filters.map((filter, index) => {
                  const set = (patch: Partial<typeof filter>) =>
                    change({
                      filters: replace(definition.filters, index, { ...filter, ...patch }),
                    });
                  const reading = helping.includes(filter.column);
                  const closed = filter.values && VALUE_OPS.has(filter.op) ? filter.values : null;
                  return (
                    <Box
                      // biome-ignore lint/suspicious/noArrayIndexKey: edited rows have no identity of their own, and a key built from their values would remount the input being typed in
                      key={index}
                      borderWidth="1px"
                      rounded="md"
                      p={3}
                    >
                      <HStack gap={2} wrap="wrap">
                        <Select
                          value={filter.column}
                          // A column takes one filter, so the others already filtered are not offered
                          options={baseColumns
                            .filter(
                              (column) =>
                                column.name === filter.column || !filtered.has(column.name),
                            )
                            .map((column) => [column.name, column.name])}
                          onChange={(value) => {
                            // Another column has other values and means something else
                            set({
                              column: value,
                              values: undefined,
                              examples: undefined,
                              description: undefined,
                            });
                            void helpFilter(value, filter.op, true);
                          }}
                        />
                        <Select
                          value={filter.op}
                          options={FILTER_OPS.map((op) => [op, OP_LABELS[op]])}
                          onChange={(value) => {
                            set({ op: value as typeof filter.op });
                            void helpFilter(filter.column, value as typeof filter.op);
                          }}
                        />
                        <Checkbox.Root
                          checked={filter.required}
                          onCheckedChange={(details) => set({ required: Boolean(details.checked) })}
                        >
                          <Checkbox.HiddenInput />
                          <Checkbox.Control />
                          <Checkbox.Label fontSize="sm">obligatorio</Checkbox.Label>
                        </Checkbox.Root>
                        <Button
                          size="xs"
                          variant="ghost"
                          ms="auto"
                          loading={reading}
                          onClick={() => void helpFilter(filter.column, filter.op, true)}
                        >
                          Leer valores y redactar de nuevo
                        </Button>
                        <IconButton
                          aria-label="Quitar el filtro"
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            change({ filters: definition.filters.filter((_, at) => at !== index) })
                          }
                        >
                          <FiMinus />
                        </IconButton>
                      </HStack>
                      <Field.Root mt={3}>
                        <Field.Label fontSize="sm">Cómo lo usa la IA</Field.Label>
                        <Textarea
                          size="sm"
                          rows={3}
                          placeholder={
                            reading
                              ? "Leyendo la columna y redactando…"
                              : "Qué significa, cómo lo pide la gente y cuándo usarlo"
                          }
                          value={filter.description ?? ""}
                          onChange={(event) => set({ description: event.target.value })}
                        />
                        <Field.HelperText>
                          El formato, los valores posibles y qué pasa si se omite los agrega el
                          sistema.
                        </Field.HelperText>
                      </Field.Root>
                      {closed && (
                        <Box mt={3}>
                          <Text fontSize="sm" fontWeight="medium">
                            Valores posibles ({closed.length})
                          </Text>
                          <Text fontSize="xs" color="fg.muted" mb={2}>
                            La IA solo puede pedir uno de estos. Anota qué significa el que no se
                            entienda solo, o quita los que no deban pedirse.
                          </Text>
                          <Stack gap={1}>
                            {closed.map((item) => (
                              <HStack key={String(item.value)} gap={2}>
                                <Badge variant="outline" fontFamily="mono" minW="32">
                                  {String(item.value)}
                                </Badge>
                                <Input
                                  size="xs"
                                  maxW="sm"
                                  placeholder="qué significa (opcional)"
                                  value={item.meaning ?? ""}
                                  onChange={(event) =>
                                    set({
                                      values: closed.map((other) =>
                                        other.value === item.value
                                          ? { ...other, meaning: event.target.value }
                                          : other,
                                      ),
                                    })
                                  }
                                />
                                <IconButton
                                  aria-label="Quitar el valor"
                                  size="2xs"
                                  variant="ghost"
                                  disabled={closed.length === 1}
                                  onClick={() =>
                                    set({
                                      values: closed.filter((other) => other.value !== item.value),
                                    })
                                  }
                                >
                                  <FiX />
                                </IconButton>
                              </HStack>
                            ))}
                          </Stack>
                        </Box>
                      )}
                      {!closed && filter.examples && (
                        <Text fontSize="xs" color="fg.muted" mt={2}>
                          Ejemplos reales que verá la IA: {filter.examples.map(String).join(", ")}
                        </Text>
                      )}
                    </Box>
                  );
                })}
                {note && (
                  <Text fontSize="sm" color="fg.muted">
                    {note}
                  </Text>
                )}
                <Button
                  size="xs"
                  variant="ghost"
                  alignSelf="start"
                  disabled={!nextColumn}
                  onClick={() => {
                    if (nextColumn) {
                      addFilter({ column: nextColumn.name, op: "=", required: false });
                    }
                  }}
                >
                  <FiPlus /> Agregar filtro
                </Button>
              </Stack>
            </Section>
          )}

          {step === 4 && (ideasLoading || shownIdeas.length > 0 || inUse) && (
            <Section
              title="Ideas de la IA"
              hint="Resúmenes que suelen pedirse con estos datos. Un clic lo aplica y abajo lo ajustas."
            >
              {inUse && (
                <Text fontSize="sm" mb={3}>
                  <Text as="span" fontWeight="medium">
                    En uso: {inUse}.
                  </Text>{" "}
                  <Text as="span" color="fg.muted">
                    Una herramienta lleva un solo resumen: elegir otra idea lo reemplaza.
                  </Text>
                </Text>
              )}
              {ideasLoading ? (
                <HStack gap={2}>
                  <Spinner size="sm" color="brand.solid" />
                  <Text fontSize="sm" color="fg.muted">
                    Buscando los resúmenes que tienen sentido para esta tabla…
                  </Text>
                </HStack>
              ) : (
                <Stack gap={2}>
                  {shownIdeas.map((idea) => (
                    <Box
                      key={idea.label}
                      as="button"
                      textAlign="start"
                      p={3}
                      borderWidth="1px"
                      rounded="md"
                      cursor="pointer"
                      _hover={{ bg: "bg.muted" }}
                      onClick={() => applyIdea(idea)}
                    >
                      <Text fontWeight="medium" fontSize="sm">
                        {idea.label}
                      </Text>
                      <Text fontSize="sm" color="fg.muted">
                        {idea.why}
                      </Text>
                      <Text fontSize="xs" color="fg.subtle" mt={1}>
                        Por {idea.group_by.join(" y ") || "todo"}:{" "}
                        {idea.aggregates
                          .map((aggregate) =>
                            aggregate.fn === "count"
                              ? `${aggregate.as} (cantidad)`
                              : `${aggregate.as} (${AGGREGATE_LABELS[aggregate.fn].toLowerCase()} de ${aggregate.column})`,
                          )
                          .join(", ")}
                      </Text>
                    </Box>
                  ))}
                </Stack>
              )}
            </Section>
          )}
          {step === 4 && (
            <Section
              title="Resumen y orden"
              hint="Para totales, agrupa por lo que quieres comparar (zona, tipo de cliente…) y elige qué calcular (suma del total, cantidad de pedidos…). Sin resumen devuelve cada fila. El orden decide qué sale primero."
            >
              <Switch.Root
                checked={definition.summary !== undefined}
                onCheckedChange={(details) =>
                  change({
                    summary: details.checked
                      ? {
                          group_by: [],
                          aggregates: [{ fn: "count", as: "total" }],
                          with_detail: true,
                        }
                      : undefined,
                    order_by: [],
                  })
                }
              >
                <Switch.HiddenInput />
                <Switch.Control />
                <Switch.Label>Resumir</Switch.Label>
              </Switch.Root>
              {definition.summary && (
                <Stack gap={2} mt={3}>
                  <Switch.Root
                    checked={definition.summary.with_detail === true}
                    onCheckedChange={(details) => {
                      const summary = definition.summary;
                      if (summary) {
                        change({ summary: { ...summary, with_detail: details.checked } });
                      }
                    }}
                  >
                    <Switch.HiddenInput />
                    <Switch.Control />
                    <Switch.Label>Incluir también cada registro</Switch.Label>
                  </Switch.Root>
                  <Text fontSize="xs" color="fg.muted">
                    {definition.summary.with_detail
                      ? "La IA recibe los totales y, aparte, cada registro con las columnas elegidas. Si el detalle es grande, va completo en un Excel con link y en la respuesta quedan los totales."
                      : "La IA recibe solo los totales; las columnas que no agrupes no salen en la respuesta."}
                  </Text>
                  {definition.summary.group_by.length === 0 && (
                    <Text fontSize="sm" color="fg.warning">
                      Sin agrupar por ninguna columna, los totales son una sola fila con todo. Marca
                      abajo por qué comparar (zona, tipo…) para tener un total por cada uno.
                    </Text>
                  )}
                  <Text fontSize="sm" color="fg.muted">
                    Agrupar por
                  </Text>
                  <HStack wrap="wrap" gap={3}>
                    {chosen.map((column) => (
                      <Checkbox.Root
                        key={column}
                        checked={definition.summary?.group_by.includes(column)}
                        onCheckedChange={(details) => {
                          const summary = definition.summary;
                          if (summary) {
                            change({
                              summary: {
                                ...summary,
                                group_by: details.checked
                                  ? [...summary.group_by, column]
                                  : summary.group_by.filter((item) => item !== column),
                              },
                            });
                          }
                        }}
                      >
                        <Checkbox.HiddenInput />
                        <Checkbox.Control />
                        <Checkbox.Label fontFamily="mono" fontSize="sm">
                          {column}
                        </Checkbox.Label>
                      </Checkbox.Root>
                    ))}
                  </HStack>
                  {definition.summary.aggregates.map((aggregate, index) => {
                    const summary = definition.summary as NonNullable<Definition["summary"]>;
                    const set = (patch: Partial<typeof aggregate>) =>
                      change({
                        summary: {
                          ...summary,
                          aggregates: replace(summary.aggregates, index, {
                            ...aggregate,
                            ...patch,
                          }),
                        },
                      });
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: edited rows have no identity of their own, and a key built from their values would remount the input being typed in
                      <HStack key={index} gap={2}>
                        <Select
                          value={aggregate.fn}
                          options={AGGREGATES.map((fn) => [fn, AGGREGATE_LABELS[fn]])}
                          onChange={(value) => set({ fn: value as typeof aggregate.fn })}
                        />
                        {aggregate.fn !== "count" && (
                          <Select
                            value={aggregate.column ?? ""}
                            options={[
                              ["", "columna…"],
                              ...chosen
                                .filter((column) => kindOf(column) === "number")
                                .map((column) => [column, column] as [string, string]),
                            ]}
                            onChange={(value) => set({ column: value || undefined })}
                          />
                        )}
                        <Text fontSize="sm" color="fg.muted">
                          como
                        </Text>
                        <Input
                          size="sm"
                          maxW="48"
                          fontFamily="mono"
                          value={aggregate.as}
                          onChange={(event) => set({ as: event.target.value })}
                        />
                        <IconButton
                          aria-label="Quitar"
                          size="xs"
                          variant="ghost"
                          disabled={summary.aggregates.length === 1}
                          onClick={() =>
                            change({
                              summary: {
                                ...summary,
                                aggregates: summary.aggregates.filter((_, at) => at !== index),
                              },
                            })
                          }
                        >
                          <FiMinus />
                        </IconButton>
                      </HStack>
                    );
                  })}
                  <Button
                    size="xs"
                    variant="ghost"
                    alignSelf="start"
                    onClick={() => {
                      const summary = definition.summary;
                      if (summary) {
                        change({
                          summary: {
                            ...summary,
                            aggregates: [
                              ...summary.aggregates,
                              { fn: "sum", as: `total_${summary.aggregates.length + 1}` },
                            ],
                          },
                        });
                      }
                    }}
                  >
                    <FiPlus /> Agregar cálculo
                  </Button>
                </Stack>
              )}
              <Stack gap={2} mt={4}>
                <Text fontSize="sm" color="fg.muted">
                  Ordenar por
                </Text>
                {definition.order_by.map((order, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: edited rows have no identity of their own, and a key built from their values would remount the input being typed in
                  <HStack key={index} gap={2}>
                    <Select
                      value={order.column}
                      options={outputNames(definition)
                        .filter((column) => column === order.column || !ordered.has(column))
                        .map((column) => [column, column])}
                      onChange={(value) =>
                        change({
                          order_by: replace(definition.order_by, index, {
                            ...order,
                            column: value,
                          }),
                        })
                      }
                    />
                    <Select
                      value={order.direction}
                      options={[
                        ["asc", "de menor a mayor"],
                        ["desc", "de mayor a menor"],
                      ]}
                      onChange={(value) =>
                        change({
                          order_by: replace(definition.order_by, index, {
                            ...order,
                            direction: value as "asc" | "desc",
                          }),
                        })
                      }
                    />
                    <IconButton
                      aria-label="Quitar"
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        change({ order_by: definition.order_by.filter((_, at) => at !== index) })
                      }
                    >
                      <FiMinus />
                    </IconButton>
                  </HStack>
                ))}
                <Button
                  size="xs"
                  variant="ghost"
                  alignSelf="start"
                  disabled={!nextOrder}
                  onClick={() => {
                    if (nextOrder) {
                      change({
                        order_by: [
                          ...definition.order_by,
                          { column: nextOrder, direction: "desc" },
                        ],
                      });
                    }
                  }}
                >
                  <FiPlus /> Agregar orden
                </Button>
              </Stack>
            </Section>
          )}

          {step === 5 && (
            <Section
              title="Nombre y descripción"
              hint="El asistente ya propone ambos a partir de lo que armaste; cámbialos si no te convencen. El nombre es como la llama la IA y la descripción, lo que lee para decidir cuándo usarla."
            >
              <Stack gap={3}>
                <Field.Root required maxW="sm" invalid={name !== "" && !NAME.test(name)}>
                  <Field.Label>Nombre</Field.Label>
                  <Input
                    value={name}
                    disabled={!isNew}
                    fontFamily="mono"
                    placeholder={busy === "suggest" ? "Sugiriendo…" : "ventas_por_zona"}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <Field.HelperText>
                    Minúsculas, números y guion bajo; empieza con una letra.
                  </Field.HelperText>
                </Field.Root>
                <HStack justify="space-between">
                  <Text fontSize="sm" color="fg.muted">
                    {busy === "suggest"
                      ? "La IA está redactando el nombre, qué devuelve y qué es cada fila…"
                      : "Redactado por la IA a partir de lo que armaste; corrígelo si hace falta."}
                  </Text>
                  <Button
                    size="xs"
                    variant="outline"
                    loading={busy === "suggest"}
                    onClick={() => suggestMeaning(true)}
                  >
                    Redactar de nuevo
                  </Button>
                </HStack>
                <Field.Root required>
                  <Field.Label>Qué devuelve</Field.Label>
                  <Textarea
                    rows={3}
                    value={definition.meaning.definition}
                    onChange={(event) =>
                      change({ meaning: { ...definition.meaning, definition: event.target.value } })
                    }
                  />
                </Field.Root>
                <Field.Root>
                  <Field.Label>Qué es cada fila</Field.Label>
                  <Input
                    placeholder="por ejemplo: el total de una zona"
                    value={definition.meaning.grain ?? ""}
                    onChange={(event) =>
                      change({ meaning: { ...definition.meaning, grain: event.target.value } })
                    }
                  />
                </Field.Root>
                {definition.meaning.synonyms.length > 0 && (
                  <Text fontSize="sm" color="fg.muted">
                    También la usará cuando pidan: {definition.meaning.synonyms.join(", ")}.
                  </Text>
                )}
                <Button size="xs" variant="ghost" alignSelf="start" onClick={() => setMore(!more)}>
                  {more ? <FiMinus /> : <FiPlus />} Más opciones
                </Button>
                {more && (
                  <Stack gap={3} ps={3} borderStartWidth="2px">
                    <Switch.Root
                      checked={definition.meaning.additive}
                      onCheckedChange={(details) =>
                        change({ meaning: { ...definition.meaning, additive: details.checked } })
                      }
                    >
                      <Switch.HiddenInput />
                      <Switch.Control />
                      <Switch.Label>
                        Sus cantidades se pueden sumar entre filas (apágalo para saldos o
                        porcentajes)
                      </Switch.Label>
                    </Switch.Root>
                    <Field.Root>
                      <Field.Label>Otras formas de pedirla</Field.Label>
                      <Input
                        placeholder="separadas por comas"
                        value={definition.meaning.synonyms.join(", ")}
                        onChange={(event) =>
                          change({
                            meaning: {
                              ...definition.meaning,
                              synonyms: event.target.value
                                .split(",")
                                .map((word) => word.trimStart()),
                            },
                          })
                        }
                      />
                    </Field.Root>
                    <Field.Root>
                      <Field.Label>Cuidados al leerla</Field.Label>
                      <Textarea
                        rows={2}
                        placeholder="uno por línea, por ejemplo: los montos no incluyen IVA"
                        value={definition.meaning.caveats.join("\n")}
                        onChange={(event) =>
                          change({
                            meaning: {
                              ...definition.meaning,
                              caveats: event.target.value.split("\n"),
                            },
                          })
                        }
                      />
                    </Field.Root>
                    <Field.Root maxW="sm">
                      <Field.Label>Zona horaria de sus fechas</Field.Label>
                      <TimeZoneSelect
                        value={definition.time_zone ?? ""}
                        onChange={(zone) => change({ time_zone: zone || undefined })}
                        inherited="la fuente"
                      />
                    </Field.Root>
                  </Stack>
                )}
              </Stack>
            </Section>
          )}

          {step === 6 && (
            <Section
              title="Revisar, guardar y publicar"
              hint="Guardar corre los chequeos sobre la base real. Si pasan, publícala: queda disponible en el chat y por MCP para quien tenga el permiso de la fuente."
            >
              <Stack gap={1} fontSize="sm">
                <Text>
                  Lee{" "}
                  <Text as="span" fontFamily="mono">
                    {definition.base.kind === "table" ? definition.base.name : "una consulta"}
                  </Text>{" "}
                  de la fuente{" "}
                  <Text as="span" fontFamily="mono">
                    {source}
                  </Text>
                  .
                </Text>
                <Text>
                  {definition.summary
                    ? `Devuelve totales${definition.summary.group_by.length > 0 ? ` por ${definition.summary.group_by.join(", ")}` : ""}: ${definition.summary.aggregates.map((aggregate) => aggregate.as).join(", ")}.`
                    : `Devuelve ${definition.columns.length} columnas, una fila por registro.`}
                </Text>
                <Text>
                  {definition.filters.length === 0
                    ? "Sin filtros: siempre devuelve todo."
                    : `Se puede pedir por ${definition.filters.map((filter) => `${filter.column}${filter.required ? " (obligatorio)" : ""}`).join(", ")}.`}
                </Text>
              </Stack>
              {status === "published" && dirty && (
                <Text fontSize="sm" color="fg.warning" mt={3}>
                  Tienes cambios sin guardar. Al guardarlos la herramienta vuelve a borrador y el
                  Chat deja de usarla hasta que la publiques otra vez.
                </Text>
              )}
              {status === "draft" && !dirty && (
                <Text fontSize="sm" color="fg.warning" mt={3}>
                  Borrador: el Chat todavía no la usa. Publícala cuando los chequeos estén bien.
                </Text>
              )}
              {status === "published" && !dirty && (
                <Text fontSize="sm" color="fg.success" mt={3}>
                  Publicada: ya está en el Chat para quien tenga el permiso de la fuente. Pregúntale
                  algo que la use.
                </Text>
              )}
              {!isNew && status && (
                <Button size="xs" variant="ghost" mt={3} onClick={() => setTrying(!trying)}>
                  {trying ? "Ocultar la prueba" : "Probar antes de publicar (opcional)"}
                </Button>
              )}
              {!canSave && (
                <Text fontSize="sm" color="fg.error" mt={3}>
                  Falta completar:{" "}
                  {STEPS.filter((_, index) => index < ready.length && !ready[index]).join(", ")}.
                </Text>
              )}
            </Section>
          )}
          {step === 6 && checks && (
            <Section title="Chequeos de la versión guardada">
              <Stack gap={1}>
                {checks.map((check) => (
                  <HStack key={check.name} gap={2} fontSize="sm" align="start">
                    <Box
                      color={check.ok ? "fg.success" : check.skipped ? "fg.subtle" : "fg.error"}
                      pt={1}
                    >
                      {check.ok ? <FiCheck /> : check.skipped ? <FiMinus /> : <FiX />}
                    </Box>
                    <Text>
                      <Text as="span" fontWeight="medium">
                        {CHECK_LABELS[check.name]}:
                      </Text>{" "}
                      {check.detail}
                    </Text>
                  </HStack>
                ))}
              </Stack>
            </Section>
          )}

          {error && (
            <Text role="alert" color="fg.error" fontSize="sm">
              {error}
            </Text>
          )}
          {step === 6 ? (
            <HStack gap={2}>
              <Button variant="ghost" onClick={() => setStep(step - 1)}>
                Atrás
              </Button>
              <Button
                colorPalette="brand"
                loading={busy === "save"}
                disabled={!canSave}
                onClick={() => void save()}
              >
                Guardar y chequear
              </Button>
              <Button
                variant="outline"
                colorPalette="green"
                loading={busy === "publish"}
                disabled={!canPublish}
                onClick={() => void publish()}
              >
                Publicar
              </Button>
              {!isNew && (
                <Button
                  variant="ghost"
                  colorPalette="red"
                  loading={busy === "delete"}
                  onClick={() => void remove()}
                >
                  <FiTrash2 /> Borrar
                </Button>
              )}
            </HStack>
          ) : (
            <HStack justify="space-between">
              <Button variant="ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>
                Atrás
              </Button>
              <Button
                colorPalette="brand"
                disabled={!ready[step] || busy === "columns" || busy === "suggest"}
                onClick={() => setStep(step + 1)}
              >
                Siguiente: {STEPS[step + 1]}
              </Button>
            </HStack>
          )}
          {step === 6 && savedAs !== null && (
            <Text fontSize="xs" color="fg.muted">
              Al lado tienes la guía, que sugiere mejoras con un clic, y un chat de prueba para ver
              cómo la usa el modelo.
            </Text>
          )}
        </Stack>
      </fieldset>
      {!isNew && status && trying && (
        <Box w={{ base: "full", xl: "420px" }} flexShrink={0}>
          <ToolLab
            name={name}
            onApply={(proposed) => {
              if (
                dirty &&
                !window.confirm("La sugerencia reemplaza los cambios que no guardaste. ¿Seguir?")
              ) {
                return false;
              }
              const next = withDefaults(proposed);
              // A suggestion over another base needs that base's columns read again
              if (JSON.stringify(next.base) !== JSON.stringify(definition.base)) {
                setBaseColumns([]);
              }
              setDefinition(next);
              setChecks(null);
              return true;
            }}
          />
        </Box>
      )}
    </Flex>
  );
}

/**
 * A titled part of the editor
 *
 * @param   props  Title, an optional hint and the content
 *
 * @return  The section
 */
function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Box bg="bg.surface" borderWidth="1px" rounded="panel" p={5}>
      <Heading size="sm" mb={hint ? 1 : 3}>
        {title}
      </Heading>
      {hint && (
        <Text fontSize="sm" color="fg.muted" mb={3}>
          {hint}
        </Text>
      )}
      {children}
    </Box>
  );
}

/**
 * A small native select over value and label pairs
 *
 * @param   props  Value, options and what to do on change
 *
 * @return  The select
 */
function Select({
  value,
  options,
  onChange,
}: {
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <NativeSelect.Root size="sm" width="auto">
      <NativeSelect.Field value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([option, label]) => (
          <option key={option} value={option}>
            {label}
          </option>
        ))}
      </NativeSelect.Field>
    </NativeSelect.Root>
  );
}

/**
 * Replaces one item of a list
 *
 * @param   list   List
 * @param   index  Position
 * @param   item   New item
 *
 * @return  A new list
 */
function replace<T>(list: T[], index: number, item: T): T[] {
  return list.map((current, at) => (at === index ? item : current));
}
