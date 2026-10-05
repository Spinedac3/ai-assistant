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
import { ToolLab } from "./ToolLab";
import {
  AGGREGATE_LABELS,
  AGGREGATES,
  type BaseColumn,
  blankDefinition,
  CHECK_LABELS,
  type CheckResult,
  cleanDefinition,
  type Definition,
  FILTER_OPS,
  OP_LABELS,
  outputNames,
  prune,
  type ToolDetail,
  withDefaults,
} from "./types";

const NAME = /^[a-z][a-z0-9_]{2,63}$/;
export const NEW_TOOL = "_nueva";

/**
 * Opens the editor fresh for each tool, so nothing of one is left in another
 *
 * @return  The page
 */
export function ToolEditorRoute() {
  const { name } = useParams();
  const location = useLocation();
  const carried = (location.state as { checks?: CheckResult[] } | null)?.checks ?? null;
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

  const readColumns = () =>
    guard("columns", async () => {
      const data = await api<{ columns: BaseColumn[] }>("/admin/tools/describe", {
        method: "POST",
        body: { source, base: definition.base },
      });
      setBaseColumns(data.columns);
      // A first read takes every column; later ones keep the choices that still exist
      const names = new Set(data.columns.map((column) => column.name));
      setDefinition((current) => ({
        ...current,
        columns:
          current.columns.length === 0
            ? data.columns.map((column) => ({ name: column.name }))
            : current.columns.filter((column) => names.has(column.name)),
      }));
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
  const isNew = initialName === null;
  const chosen = definition.columns.map((column) => column.name);
  const kindOf = (column: string) => baseColumns.find((base) => base.name === column)?.kind;
  const canSave =
    NAME.test(name) &&
    source !== "" &&
    definition.columns.length > 0 &&
    definition.meaning.definition.trim() !== "" &&
    definition.meaning.grain.trim() !== "" &&
    (definition.summary?.aggregates ?? []).every(
      (aggregate) => aggregate.as !== "" && (aggregate.fn === "count" || aggregate.column),
    );
  const dirty = JSON.stringify(cleanDefinition(definition)) !== savedAs;
  // The server checks again before publishing; what matters here is that what is shown is saved
  const canPublish = savedAs !== null && !dirty && status === "draft";

  return (
    <Flex gap={4} align="start" direction={{ base: "column", xl: "row" }}>
      {/* Nothing changes while a version is being saved and checked */}
      <fieldset
        disabled={busy === "save"}
        style={{ flex: 1, minWidth: 0, border: 0, padding: 0, margin: 0, width: "100%" }}
      >
        <Stack gap={4}>
          <Section title="Qué es">
            <HStack gap={3} align="start" wrap="wrap">
              <Field.Root required maxW="sm" invalid={name !== "" && !NAME.test(name)}>
                <Field.Label>Nombre</Field.Label>
                <Input
                  value={name}
                  disabled={!isNew}
                  fontFamily="mono"
                  placeholder="entregas_por_ruta"
                  onChange={(event) => setName(event.target.value)}
                />
                <Field.HelperText>
                  Minúsculas y guion bajo; es como la llama el modelo.
                </Field.HelperText>
              </Field.Root>
              <Field.Root required maxW="xs">
                <Field.Label>Fuente</Field.Label>
                <NativeSelect.Root disabled={!isNew}>
                  <NativeSelect.Field
                    value={source}
                    onChange={(event) => setSource(event.target.value)}
                  >
                    {sources.length === 0 && <option value="">No tienes fuentes</option>}
                    {sources.map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </NativeSelect.Field>
                </NativeSelect.Root>
              </Field.Root>
              {status && (
                <Badge
                  alignSelf="center"
                  variant="subtle"
                  colorPalette={status === "published" ? "green" : "gray"}
                >
                  {status === "published" ? "Publicada" : "Borrador"}
                </Badge>
              )}
            </HStack>
          </Section>

          <Section title="Qué lee">
            <SegmentGroup.Root
              size="sm"
              value={definition.base.kind}
              onValueChange={(details) =>
                change({
                  base:
                    details.value === "query"
                      ? { kind: "query", sql: "" }
                      : { kind: "table", name: "" },
                })
              }
            >
              <SegmentGroup.Indicator />
              <SegmentGroup.Items
                items={[
                  { value: "table", label: "Una tabla o vista" },
                  { value: "query", label: "Una consulta" },
                ]}
              />
            </SegmentGroup.Root>
            {definition.base.kind === "table" ? (
              <Input
                mt={3}
                fontFamily="mono"
                placeholder="esquema.tabla"
                value={definition.base.name}
                onChange={(event) => change({ base: { kind: "table", name: event.target.value } })}
              />
            ) : (
              <Textarea
                mt={3}
                fontFamily="mono"
                fontSize="sm"
                rows={6}
                placeholder="select ... from ...  (sin ORDER BY; el orden se pone abajo)"
                value={definition.base.sql}
                onChange={(event) => change({ base: { kind: "query", sql: event.target.value } })}
              />
            )}
            <Button
              mt={3}
              size="sm"
              variant="outline"
              loading={busy === "columns"}
              disabled={
                !source ||
                (definition.base.kind === "table"
                  ? !definition.base.name
                  : !definition.base.sql.trim())
              }
              onClick={() => void readColumns()}
            >
              Leer columnas
            </Button>
          </Section>

          {baseColumns.length > 0 && (
            <Section
              title="Qué columnas devuelve"
              hint="Desmarca las que no aportan; la etiqueta es como las nombra una persona."
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
                        {column.kind}
                      </Badge>
                      {picked && (
                        <Input
                          size="sm"
                          maxW="xs"
                          placeholder="Etiqueta (opcional)"
                          value={picked.label ?? ""}
                          onChange={(event) =>
                            change({
                              columns: definition.columns.map((item) =>
                                item.name === column.name
                                  ? { ...item, label: event.target.value }
                                  : item,
                              ),
                            })
                          }
                        />
                      )}
                    </HStack>
                  );
                })}
              </Stack>
            </Section>
          )}

          {baseColumns.length > 0 && (
            <Section
              title="Por qué se puede filtrar"
              hint="Cada filtro es algo que la persona puede pedir; uno obligatorio siempre se pide."
            >
              <Stack gap={2}>
                {definition.filters.map((filter, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: edited rows have no identity of their own, and a key built from their values would remount the input being typed in
                  <HStack key={index} gap={2} wrap="wrap">
                    <Select
                      value={filter.column}
                      options={baseColumns.map((column) => [column.name, column.name])}
                      onChange={(value) =>
                        change({
                          filters: replace(definition.filters, index, { ...filter, column: value }),
                        })
                      }
                    />
                    <Select
                      value={filter.op}
                      options={FILTER_OPS.map((op) => [op, OP_LABELS[op]])}
                      onChange={(value) =>
                        change({
                          filters: replace(definition.filters, index, {
                            ...filter,
                            op: value as typeof filter.op,
                          }),
                        })
                      }
                    />
                    <Checkbox.Root
                      checked={filter.required}
                      onCheckedChange={(details) =>
                        change({
                          filters: replace(definition.filters, index, {
                            ...filter,
                            required: Boolean(details.checked),
                          }),
                        })
                      }
                    >
                      <Checkbox.HiddenInput />
                      <Checkbox.Control />
                      <Checkbox.Label fontSize="sm">obligatorio</Checkbox.Label>
                    </Checkbox.Root>
                    <Input
                      size="sm"
                      flex={1}
                      minW="48"
                      placeholder="Para qué sirve (lo lee el modelo)"
                      value={filter.description ?? ""}
                      onChange={(event) =>
                        change({
                          filters: replace(definition.filters, index, {
                            ...filter,
                            description: event.target.value,
                          }),
                        })
                      }
                    />
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
                ))}
                <Button
                  size="xs"
                  variant="ghost"
                  alignSelf="start"
                  onClick={() =>
                    change({
                      filters: [
                        ...definition.filters,
                        { column: baseColumns[0]?.name ?? "", op: "=", required: false },
                      ],
                    })
                  }
                >
                  <FiPlus /> Agregar filtro
                </Button>
              </Stack>
            </Section>
          )}

          {baseColumns.length > 0 && (
            <Section
              title="Resumen y orden"
              hint="Agrupar suma o cuenta por las columnas que elijas; sin resumen devuelve cada fila."
            >
              <Switch.Root
                checked={definition.summary !== undefined}
                onCheckedChange={(details) =>
                  change({
                    summary: details.checked
                      ? { group_by: [], aggregates: [{ fn: "count", as: "total" }] }
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
                      options={outputNames(definition).map((column) => [column, column])}
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
                  disabled={outputNames(definition).length === 0}
                  onClick={() =>
                    change({
                      order_by: [
                        ...definition.order_by,
                        { column: outputNames(definition)[0] ?? "", direction: "asc" },
                      ],
                    })
                  }
                >
                  <FiPlus /> Agregar orden
                </Button>
              </Stack>
            </Section>
          )}

          {baseColumns.length > 0 && (
            <Section
              title="Qué significa"
              hint="Lo lee el modelo antes de usarla: dilo como se lo dirías a alguien nuevo."
            >
              <Stack gap={3}>
                <Field.Root required>
                  <Field.Label>Qué devuelve</Field.Label>
                  <Textarea
                    rows={2}
                    value={definition.meaning.definition}
                    onChange={(event) =>
                      change({ meaning: { ...definition.meaning, definition: event.target.value } })
                    }
                  />
                </Field.Root>
                <HStack gap={3} align="end">
                  <Field.Root required>
                    <Field.Label>Qué es cada fila</Field.Label>
                    <Input
                      placeholder="una entrega, un día por ruta…"
                      value={definition.meaning.grain}
                      onChange={(event) =>
                        change({ meaning: { ...definition.meaning, grain: event.target.value } })
                      }
                    />
                  </Field.Root>
                  <Switch.Root
                    checked={definition.meaning.additive}
                    onCheckedChange={(details) =>
                      change({ meaning: { ...definition.meaning, additive: details.checked } })
                    }
                    pb={2}
                  >
                    <Switch.HiddenInput />
                    <Switch.Control />
                    <Switch.Label>Sus cantidades se pueden sumar</Switch.Label>
                  </Switch.Root>
                </HStack>
                <Field.Root>
                  <Field.Label>Otras formas de llamarlo</Field.Label>
                  <Input
                    placeholder="separadas por comas"
                    value={definition.meaning.synonyms.join(", ")}
                    onChange={(event) =>
                      change({
                        meaning: {
                          ...definition.meaning,
                          synonyms: event.target.value.split(",").map((word) => word.trimStart()),
                        },
                      })
                    }
                  />
                </Field.Root>
                <Field.Root>
                  <Field.Label>Cuidados al leerlo</Field.Label>
                  <Textarea
                    rows={2}
                    placeholder="uno por línea"
                    value={definition.meaning.caveats.join("\n")}
                    onChange={(event) =>
                      change({
                        meaning: { ...definition.meaning, caveats: event.target.value.split("\n") },
                      })
                    }
                  />
                </Field.Root>
                <Field.Root maxW="sm">
                  <Field.Label>Zona horaria de sus fechas</Field.Label>
                  <Input
                    placeholder="vacío = la de la fuente"
                    value={definition.time_zone ?? ""}
                    onChange={(event) => change({ time_zone: event.target.value || undefined })}
                  />
                </Field.Root>
              </Stack>
            </Section>
          )}

          {error && (
            <Text role="alert" color="fg.error" fontSize="sm">
              {error}
            </Text>
          )}
          {checks && (
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
          <HStack gap={2}>
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
        </Stack>
      </fieldset>
      {!isNew && status && (
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
