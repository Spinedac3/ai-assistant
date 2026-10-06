import {
  Badge,
  Box,
  Button,
  Dialog,
  Field,
  HStack,
  Input,
  NativeSelect,
  Portal,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { FiFileText } from "react-icons/fi";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiError, api } from "../api/http";
import { useSession } from "../api/session";

// The converted text comes from a PDF nobody checked: an image would be fetched from wherever it
// points the moment the review opens, and a link could lead anywhere
const UNTRUSTED: Components = {
  img: ({ alt }) => (
    <Text as="span" color="fg.muted">
      {`[imagen${alt ? `: ${alt}` : ""}]`}
    </Text>
  ),
  a: ({ children }) => (
    <Text as="span" textDecoration="underline">
      {children}
    </Text>
  ),
};

interface ConversionRow {
  id: string;
  file_name: string;
  status: "queued" | "running" | "done" | "failed" | "publishing";
  pages_done: number;
  pages_total: number | null;
  error: string | null;
}

interface Header {
  doc_code: string;
  doc_title: string;
  doc_version: string;
  doc_type: string | null;
  area: string;
  tags: string[];
}

interface Conversion extends ConversionRow {
  markdown: string | null;
  suggested: Header | null;
}

/**
 * Uploads a PDF alone, for the assistant to turn into a document to review
 *
 * @return  The button and its dialog
 */
export function PdfUploadButton() {
  const queries = useQueryClient();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (!file) {
      return;
    }
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append("original", file, file.name);
    try {
      await api("/docs/conversions", { method: "POST", body: form });
      await queries.invalidateQueries({ queryKey: ["conversions"] });
      setOpen(false);
      setFile(null);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "No se pudo subir el PDF");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(details) => setOpen(details.open)}>
      <Dialog.Trigger asChild>
        <Button colorPalette="brand" size="sm">
          <FiFileText /> Subir PDF
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content as="form" onSubmit={submit}>
            <Dialog.Header>
              <Dialog.Title>Subir un PDF</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap={3}>
                <Field.Root required>
                  <Field.Label>Archivo PDF</Field.Label>
                  <Input
                    type="file"
                    accept="application/pdf,.pdf"
                    pt={1.5}
                    onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  />
                  <Field.HelperText>
                    El asistente lo lee y lo convierte en un documento; luego revisas su encabezado
                    y lo publicas. Hasta 50 MB y 300 páginas.
                  </Field.HelperText>
                </Field.Root>
                {error && (
                  <Text role="alert" color="fg.error" fontSize="sm">
                    {error}
                  </Text>
                )}
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button variant="outline">Cancelar</Button>
              </Dialog.ActionTrigger>
              <Button type="submit" colorPalette="brand" loading={busy} disabled={!file}>
                Convertir
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/**
 * The person's PDFs being converted or waiting for review, with how far each one went
 *
 * @param   props  What to do with the job a published document queues
 *
 * @return  The list, or nothing when there is none
 */
export function Conversions({ onQueued }: { onQueued: (job: number) => void }) {
  const queries = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["conversions"],
    queryFn: () => api<ConversionRow[]>("/docs/conversions"),
    // Asked again while any is still being written, so the progress moves on its own
    refetchInterval: (query) =>
      query.state.data?.some((row) => row.status === "queued" || row.status === "running")
        ? 3_000
        : false,
  });
  const rows = list.data ?? [];
  if (rows.length === 0) {
    return null;
  }

  const discard = async (id: string) => {
    setError(null);
    try {
      await api(`/docs/conversions/${id}`, { method: "DELETE" });
      await queries.invalidateQueries({ queryKey: ["conversions"] });
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "No se pudo descartar");
    }
  };

  return (
    <Box bg="bg.surface" borderWidth="1px" rounded="panel" p={4}>
      <Text fontWeight="medium" mb={2}>
        PDF en conversión
      </Text>
      <Stack gap={2}>
        {rows.map((row) => (
          <HStack key={row.id} gap={3} wrap="wrap">
            <Text fontSize="sm" flex={1} minW="48" lineClamp={1}>
              {row.file_name}
            </Text>
            {row.status === "done" ? (
              <Badge colorPalette="green" variant="subtle">
                Lista para revisar
              </Badge>
            ) : row.status === "failed" ? (
              <Text fontSize="sm" color="fg.error">
                {row.error ?? "No se pudo convertir"}
              </Text>
            ) : (
              <HStack gap={2}>
                <Spinner size="xs" color="brand.solid" />
                <Text fontSize="sm" color="fg.muted">
                  {row.status === "queued"
                    ? "En espera"
                    : `Convirtiendo: ${row.pages_done} de ${row.pages_total ?? "?"} páginas`}
                </Text>
              </HStack>
            )}
            {row.status === "done" && (
              <ReviewButton
                id={row.id}
                onPublished={(job) => {
                  onQueued(job);
                  void queries.invalidateQueries({ queryKey: ["conversions"] });
                }}
              />
            )}
            {row.status !== "publishing" && (
              <Button
                size="xs"
                variant="ghost"
                colorPalette="red"
                onClick={() => void discard(row.id)}
              >
                Descartar
              </Button>
            )}
          </HStack>
        ))}
        {error && (
          <Text role="alert" color="fg.error" fontSize="sm">
            {error}
          </Text>
        )}
      </Stack>
    </Box>
  );
}

/**
 * Reviews a converted PDF: its suggested header to correct, and its Markdown to read or edit,
 * before publishing it
 *
 * @param   props  The conversion and what to do with the job its publishing queues
 *
 * @return  The button and its dialog
 */
function ReviewButton({ id, onPublished }: { id: string; onPublished: (job: number) => void }) {
  const session = useSession();
  // A document can only go to an area the person reads, as publishing checks
  const areas = (session?.user.scopes ?? [])
    .map((scope) => scope.match(/^docs\.([a-z0-9_-]+)\.read$/)?.[1])
    .filter((area): area is string => Boolean(area));
  const [open, setOpen] = useState(false);
  const [header, setHeader] = useState<Header | null>(null);
  // The document as converted; it is read here and published as it is
  const [markdown, setMarkdown] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setError(null);
    try {
      const found = await api<Conversion>(`/docs/conversions/${id}`);
      setHeader(
        found.suggested ?? {
          doc_code: "",
          doc_title: found.file_name.replace(/\.pdf$/i, ""),
          doc_version: "V001",
          doc_type: null,
          area: areas[0] ?? "general",
          tags: [],
        },
      );
      setMarkdown(found.markdown ?? "");
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "No se pudo abrir la conversión");
    }
  };

  const publish = async () => {
    if (!header) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const queued = await api<{ job_id: number }>(`/docs/conversions/${id}/publish`, {
        method: "POST",
        body: {
          header: {
            doc_code: header.doc_code.trim(),
            doc_title: header.doc_title.trim(),
            doc_version: header.doc_version.trim(),
            area: header.area,
            ...(header.doc_type?.trim() ? { doc_type: header.doc_type.trim() } : {}),
            tags: header.tags.map((tag) => tag.trim()).filter(Boolean),
          },
        },
      });
      onPublished(queued.job_id);
      setOpen(false);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "No se pudo publicar");
    } finally {
      setBusy(false);
    }
  };

  const set = (patch: Partial<Header>) =>
    setHeader((current) => (current ? { ...current, ...patch } : current));

  return (
    <Dialog.Root
      open={open}
      size="xl"
      onOpenChange={(details) => {
        setOpen(details.open);
        if (details.open) {
          void start();
        }
      }}
    >
      <Dialog.Trigger asChild>
        <Button size="xs" colorPalette="brand">
          Revisar
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="5xl">
            <Dialog.Header>
              <Dialog.Title>Revisar y publicar</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              {!header ? (
                error ? (
                  <Text color="fg.error">{error}</Text>
                ) : (
                  <Spinner color="brand.solid" />
                )
              ) : (
                <Stack gap={4}>
                  <Text fontSize="sm" color="fg.muted">
                    El asistente sugirió el encabezado; corrígelo si hace falta. Con el mismo código
                    y una versión mayor, reemplaza a la versión vigente.
                  </Text>
                  <HStack gap={3} align="start" wrap="wrap">
                    <Field.Root required maxW="xs">
                      <Field.Label>Código</Field.Label>
                      <Input
                        fontFamily="mono"
                        value={header.doc_code}
                        onChange={(event) => set({ doc_code: event.target.value })}
                      />
                    </Field.Root>
                    <Field.Root required maxW="2xs">
                      <Field.Label>Versión</Field.Label>
                      <Input
                        value={header.doc_version}
                        onChange={(event) => set({ doc_version: event.target.value })}
                      />
                    </Field.Root>
                    <Field.Root required maxW="xs">
                      <Field.Label>Área</Field.Label>
                      <NativeSelect.Root>
                        <NativeSelect.Field
                          value={header.area}
                          onChange={(event) => set({ area: event.target.value })}
                        >
                          {[...new Set([header.area, ...areas])].map((area) => (
                            <option key={area} value={area}>
                              {area}
                            </option>
                          ))}
                        </NativeSelect.Field>
                        <NativeSelect.Indicator />
                      </NativeSelect.Root>
                      <Field.HelperText>Quién puede leerlo.</Field.HelperText>
                    </Field.Root>
                  </HStack>
                  <Field.Root required>
                    <Field.Label>Título</Field.Label>
                    <Input
                      value={header.doc_title}
                      onChange={(event) => set({ doc_title: event.target.value })}
                    />
                  </Field.Root>
                  <HStack gap={3} align="start" wrap="wrap">
                    <Field.Root maxW="xs">
                      <Field.Label>Tipo</Field.Label>
                      <Input
                        placeholder="manual, política, procedimiento…"
                        value={header.doc_type ?? ""}
                        onChange={(event) => set({ doc_type: event.target.value })}
                      />
                    </Field.Root>
                    <Field.Root flex={1} minW="64">
                      <Field.Label>Etiquetas</Field.Label>
                      <Input
                        placeholder="separadas por comas"
                        value={header.tags.join(", ")}
                        onChange={(event) =>
                          set({ tags: event.target.value.split(",").map((tag) => tag.trimStart()) })
                        }
                      />
                    </Field.Root>
                  </HStack>
                  <Text fontWeight="medium" fontSize="sm">
                    Así quedó el documento
                  </Text>
                  <Box
                    borderWidth="1px"
                    rounded="md"
                    p={4}
                    maxH="50vh"
                    overflow="auto"
                    fontSize="sm"
                    css={{
                      "& table": { borderCollapse: "collapse" },
                      "& td, & th": {
                        border: "1px solid",
                        borderColor: "border",
                        padding: "2px 6px",
                      },
                    }}
                  >
                    <Markdown remarkPlugins={[remarkGfm]} components={UNTRUSTED}>
                      {markdown}
                    </Markdown>
                  </Box>
                  {error && (
                    <Text role="alert" color="fg.error" fontSize="sm">
                      {error}
                    </Text>
                  )}
                </Stack>
              )}
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button variant="outline">Cerrar</Button>
              </Dialog.ActionTrigger>
              <Button
                colorPalette="brand"
                loading={busy}
                disabled={!header?.doc_code.trim() || !header?.doc_title.trim()}
                onClick={() => void publish()}
              >
                Publicar
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
