import {
  Badge,
  Box,
  Button,
  Code,
  Field,
  HStack,
  Input,
  NativeSelect,
  SegmentGroup,
  Stack,
  Tabs,
  Text,
  Textarea,
} from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { FiCheck, FiX } from "react-icons/fi";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiError, api, request } from "../api/http";
import { argument, type Definition, type ToolDetail, type TraceEntry, typeOf } from "./types";

interface Chip {
  label: string;
  why: string;
  definition: Definition;
}

/**
 * Beside the editor: the guide that suggests changes, a direct run, a trial chat and what the
 * model reads of the tool. Everything here works on the saved version
 *
 * @param   props  The tool, and how to load a suggested definition into the form
 *
 * @return  The lab
 */
export function ToolLab({
  name,
  onApply,
}: {
  name: string;
  // Whether the suggestion was loaded; the person may keep the changes they had instead
  onApply: (definition: Definition) => boolean;
}) {
  return (
    <Box bg="bg.surface" borderWidth="1px" rounded="panel" p={4}>
      <Tabs.Root defaultValue="guide" size="sm" variant="line">
        <Tabs.List mb={3}>
          <Tabs.Trigger value="guide">Guía</Tabs.Trigger>
          <Tabs.Trigger value="run">Probar</Tabs.Trigger>
          <Tabs.Trigger value="chat">Chat de prueba</Tabs.Trigger>
          <Tabs.Trigger value="model">Lo que ve el modelo</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="guide">
          <Guide name={name} onApply={onApply} />
        </Tabs.Content>
        <Tabs.Content value="run">
          <Run name={name} />
        </Tabs.Content>
        <Tabs.Content value="chat">
          <TrialChat name={name} />
        </Tabs.Content>
        <Tabs.Content value="model">
          <ModelView name={name} />
        </Tabs.Content>
      </Tabs.Root>
    </Box>
  );
}

/**
 * Asks the model what would make the tool better, with each change as a chip to try
 *
 * @param   props  The tool and how to apply a chip
 *
 * @return  The guide
 */
function Guide({ name, onApply }: { name: string; onApply: (definition: Definition) => boolean }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{
    explanation: string;
    chips: Chip[];
    dropped: number;
  } | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    setBusy(true);
    setError(null);
    setApplied(null);
    try {
      setAnswer(
        await api(`/admin/tools/${name}/guide`, {
          method: "POST",
          body: question.trim() ? { question: question.trim() } : {},
        }),
      );
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "La guía no respondió");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap={3}>
      <Text fontSize="sm" color="fg.muted">
        La guía mira la herramienta y unas muestras de sus datos, y propone cambios. Ninguno se
        aplica solo: un chip carga el cambio en el formulario y tú decides si guardarlo.
      </Text>
      <Textarea
        rows={2}
        size="sm"
        placeholder="Pregunta algo puntual (opcional)"
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
      />
      <Button
        size="sm"
        colorPalette="brand"
        loading={busy}
        loadingText="Pensando"
        onClick={() => void ask()}
      >
        Pedir sugerencias
      </Button>
      {error && (
        <Text role="alert" fontSize="sm" color="fg.error">
          {error}
        </Text>
      )}
      {answer && (
        <Stack gap={3}>
          <Box className="markdown" fontSize="sm">
            <Markdown remarkPlugins={[remarkGfm]}>{answer.explanation}</Markdown>
          </Box>
          {answer.chips.map((chip) => (
            <Box key={`${chip.label}:${chip.why}`} borderWidth="1px" rounded="md" p={3}>
              <HStack justify="space-between" align="start" gap={3}>
                <Stack gap={0}>
                  <Text fontSize="sm" fontWeight="semibold">
                    {chip.label}
                  </Text>
                  <Text fontSize="xs" color="fg.muted">
                    {chip.why}
                  </Text>
                </Stack>
                <Button
                  size="xs"
                  variant="subtle"
                  colorPalette="brand"
                  onClick={() => {
                    if (onApply(chip.definition)) {
                      setApplied(chip.label);
                    }
                  }}
                >
                  {applied === chip.label ? <FiCheck /> : null}
                  Aplicar
                </Button>
              </HStack>
            </Box>
          ))}
          {applied && (
            <Text fontSize="xs" color="fg.muted">
              Cargado en el formulario. Guarda para chequearlo; si no te convence, recarga la
              página.
            </Text>
          )}
          {answer.dropped > 0 && (
            <Text fontSize="xs" color="fg.subtle">
              {answer.dropped} sugerencia(s) no se mostraron porque no se podían aplicar tal cual.
            </Text>
          )}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * Runs the saved tool with arguments a person fills in, as the model would call it
 *
 * @param   props  The tool
 *
 * @return  The form and the result
 */
function Run({ name }: { name: string }) {
  const detail = useQuery({
    queryKey: ["tool", name],
    queryFn: () => api<ToolDetail>(`/admin/tools/${name}`),
  });
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const properties = Object.entries(detail.data?.input_schema.properties ?? {});
  const required = new Set(detail.data?.input_schema.required ?? []);

  const run = async () => {
    const args = Object.fromEntries(
      properties
        .filter(([key]) => values[key] !== undefined && values[key] !== "")
        .map(([key, schema]) => [key, argument(schema, values[key] ?? "")]),
    );
    // A number that does not read as one is said here, not sent as nothing
    const wrong = Object.entries(args).find(([, value]) =>
      [value].flat().some((item) => typeof item === "number" && Number.isNaN(item)),
    );
    if (wrong) {
      setResult(`«${wrong[0]}» lleva un número que no se entiende`);
      return;
    }
    setBusy(true);
    try {
      const response = await request(`/admin/tools/${name}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ args }),
      });
      setResult(JSON.stringify(await response.json(), null, 2));
    } catch {
      setResult("No se pudo correr; vuelve a intentarlo");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap={3}>
      {properties.length === 0 && (
        <Text fontSize="sm" color="fg.muted">
          No tiene filtros: devuelve todo de una vez.
        </Text>
      )}
      {properties.map(([key, schema]) => (
        <Field.Root key={key} required={required.has(key)}>
          <Field.Label fontFamily="mono" fontSize="xs">
            {key}
          </Field.Label>
          {typeOf(schema) === "boolean" ? (
            // Three choices: an optional yes or no can also be left out
            <NativeSelect.Root size="sm">
              <NativeSelect.Field
                value={String(values[key] ?? "")}
                onChange={(event) => setValues({ ...values, [key]: event.target.value })}
              >
                <option value="">sin indicar</option>
                <option value="true">sí</option>
                <option value="false">no</option>
              </NativeSelect.Field>
            </NativeSelect.Root>
          ) : (
            <Input
              size="sm"
              value={String(values[key] ?? "")}
              placeholder={typeOf(schema) === "array" ? "valores separados por comas" : undefined}
              onChange={(event) => setValues({ ...values, [key]: event.target.value })}
            />
          )}
          {schema.description && <Field.HelperText>{schema.description}</Field.HelperText>}
        </Field.Root>
      ))}
      <Button size="sm" colorPalette="brand" loading={busy} onClick={() => void run()}>
        Correr
      </Button>
      {result && (
        <Code
          as="pre"
          p={3}
          fontSize="xs"
          whiteSpace="pre-wrap"
          maxH="96"
          overflow="auto"
          display="block"
        >
          {result}
        </Code>
      )}
    </Stack>
  );
}

/**
 * A chat with the model through the real path, using only the draft or the whole catalog, with
 * what each call received and returned
 *
 * @param   props  The tool
 *
 * @return  The trial chat
 */
function TrialChat({ name }: { name: string }) {
  const [scope, setScope] = useState<"tool" | "catalog">("tool");
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [turns, setTurns] = useState<
    { id: string; question: string; answer: string; trace: TraceEntry[] }[]
  >([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    const question = message.trim();
    if (!question) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ conversation_id: number; answer: string; trace: TraceEntry[] }>(
        `/admin/tools/${name}/chat`,
        {
          method: "POST",
          body: {
            message: question,
            scope,
            ...(conversationId ? { conversation_id: conversationId } : {}),
          },
        },
      );
      setConversationId(data.conversation_id);
      setTurns((current) => [
        ...current,
        { id: crypto.randomUUID(), question, answer: data.answer, trace: data.trace },
      ]);
      setMessage("");
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "No respondió; vuelve a intentarlo");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap={3}>
      <SegmentGroup.Root
        size="xs"
        value={scope}
        disabled={turns.length > 0}
        onValueChange={(details) => setScope(details.value as "tool" | "catalog")}
      >
        <SegmentGroup.Indicator />
        <SegmentGroup.Items
          items={[
            { value: "tool", label: "Solo esta herramienta" },
            { value: "catalog", label: "Todo el catálogo" },
          ]}
        />
      </SegmentGroup.Root>
      <Text fontSize="xs" color="fg.muted">
        {scope === "tool"
          ? "El modelo la llama directo: prueba si la entiende y la usa bien."
          : "El modelo la busca entre todas: prueba si la encuentra cuando hace falta."}
      </Text>
      {turns.map((turn) => (
        <Stack key={turn.id} gap={2}>
          <Box alignSelf="flex-end" bg="brand.subtle" px={3} py={1} rounded="md" fontSize="sm">
            {turn.question}
          </Box>
          {turn.trace.map((entry) => (
            <Box key={entry.id} borderWidth="1px" rounded="md" p={2} fontSize="xs">
              <HStack gap={2}>
                {entry.ok === false ? <FiX /> : <FiCheck />}
                <Text fontFamily="mono" fontWeight="semibold">
                  {entry.tool.replace(/^mcp__[^_]+__/, "")}
                </Text>
                {entry.bytes !== null && <Badge size="xs">{entry.bytes} bytes</Badge>}
                {entry.excel && exportLink(entry.excel) && (
                  <a href={entry.excel} target="_blank" rel="noopener noreferrer">
                    Excel
                  </a>
                )}
              </HStack>
              <Code display="block" whiteSpace="pre-wrap" fontSize="xs" mt={1}>
                {JSON.stringify(entry.args)}
              </Code>
              {entry.result && (
                <details>
                  <summary>Lo que devolvió</summary>
                  <Code
                    display="block"
                    whiteSpace="pre-wrap"
                    fontSize="xs"
                    maxH="48"
                    overflow="auto"
                  >
                    {entry.result}
                  </Code>
                </details>
              )}
            </Box>
          ))}
          <Box className="markdown" fontSize="sm">
            <Markdown remarkPlugins={[remarkGfm]}>{turn.answer}</Markdown>
          </Box>
        </Stack>
      ))}
      {error && (
        <Text role="alert" fontSize="sm" color="fg.error">
          {error}
        </Text>
      )}
      <Textarea
        rows={2}
        size="sm"
        placeholder="Pregunta como lo haría una persona"
        value={message}
        onChange={(event) => setMessage(event.target.value)}
      />
      <HStack>
        <Button
          size="sm"
          colorPalette="brand"
          loading={busy}
          loadingText="Respondiendo"
          onClick={() => void send()}
        >
          Preguntar
        </Button>
        {turns.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setTurns([]);
              setConversationId(null);
            }}
          >
            Empezar otra
          </Button>
        )}
      </HStack>
    </Stack>
  );
}

/**
 * What the model reads of the saved tool: its description and the shapes of its input and output
 *
 * @param   props  The tool
 *
 * @return  The view
 */
function ModelView({ name }: { name: string }) {
  const detail = useQuery({
    queryKey: ["tool", name],
    queryFn: () => api<ToolDetail>(`/admin/tools/${name}`),
  });
  if (!detail.data) {
    return null;
  }

  return (
    <Stack gap={3}>
      <Text fontSize="sm" color="fg.muted">
        Esto es lo único que el modelo sabe de la herramienta antes de llamarla.
      </Text>
      <Code display="block" whiteSpace="pre-wrap" p={3} fontSize="xs">
        {detail.data.description}
      </Code>
      <Text fontSize="xs" fontWeight="semibold">
        Lo que recibe
      </Text>
      <Code display="block" whiteSpace="pre-wrap" p={3} fontSize="xs" maxH="64" overflow="auto">
        {JSON.stringify(detail.data.input_schema, null, 2)}
      </Code>
      <Text fontSize="xs" fontWeight="semibold">
        Lo que devuelve
      </Text>
      <Code display="block" whiteSpace="pre-wrap" p={3} fontSize="xs" maxH="64" overflow="auto">
        {JSON.stringify(detail.data.output_schema, null, 2)}
      </Code>
    </Stack>
  );
}

/**
 * Tells whether a link from a tool result is an Excel of the assistant: a web address to its
 * exports, whatever address the server is reached by
 *
 * @param   url  Link
 *
 * @return  Whether it is safe to show
 */
function exportLink(url: string): boolean {
  if (!URL.canParse(url)) {
    return false;
  }
  const link = new URL(url);
  return ["https:", "http:"].includes(link.protocol) && link.pathname.startsWith("/exports/");
}
