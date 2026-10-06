import {
  Badge,
  Box,
  Button,
  Dialog,
  Field,
  HStack,
  IconButton,
  Input,
  Portal,
  Spinner,
  Stack,
  Table,
  Text,
} from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { FiDownload, FiRefreshCw, FiTrash2, FiUpload } from "react-icons/fi";
import { ApiError, api, request } from "../api/http";
import { can, useSession } from "../api/session";
import { Conversions, PdfUploadButton } from "./Conversions";

interface DocumentRow {
  doc_code: string;
  doc_title: string;
  doc_version: string;
  doc_type?: string;
  required_scope: string;
  updated_at?: string;
}

interface Job {
  id: number;
  docCode: string;
  status: "queued" | "running" | "done" | "failed";
  error: string | null;
}

/**
 * The documents the person may read, and for whoever manages them, loading, reindexing and
 * deleting
 *
 * @return  The page
 */
export function DocsPage() {
  const session = useSession();
  const manager = can(session, "docs.manage");
  const queries = useQueryClient();
  const [jobs, setJobs] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({ queryKey: ["docs"], queryFn: () => api<DocumentRow[]>("/docs") });

  const follow = (job: number) => setJobs((current) => [...current, job]);
  const settled = async (job: number) => {
    setJobs((current) => current.filter((id) => id !== job));
    await queries.invalidateQueries({ queryKey: ["docs"] });
  };

  const download = async (code: string) => {
    setError(null);
    try {
      const response = await request(`/docs/${encodeURIComponent(code)}/original`);
      if (!response.ok) {
        setError("Ese documento no tiene original guardado, o ya no puedes leerlo");
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `${code}${extensionOf(response.headers.get("content-type"))}`;
      document.body.append(link);
      link.click();
      link.remove();
      // Some browsers start the download after the click returns; the file must still be there
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setError("No se pudo descargar; vuelve a intentarlo");
    }
  };

  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "No se pudo completar");
    }
  };

  return (
    <Stack gap={4}>
      <HStack justify="space-between">
        <Text color="fg.muted" fontSize="sm">
          Los documentos que el asistente usa para responder; ves los de las áreas a las que tienes
          acceso.
        </Text>
        {manager && (
          <HStack gap={2}>
            <UploadButton onQueued={follow} />
            <PdfUploadButton />
          </HStack>
        )}
      </HStack>
      {manager && <Conversions onQueued={follow} />}
      {jobs.map((job) => (
        <JobStatus key={job} id={job} onSettled={() => void settled(job)} />
      ))}
      {error && (
        <Text role="alert" color="fg.error" fontSize="sm">
          {error}
        </Text>
      )}
      <Box bg="bg.surface" borderWidth="1px" rounded="panel" overflow="auto">
        {list.isLoading ? (
          <Spinner m={6} color="brand.solid" />
        ) : list.data?.length === 0 ? (
          <Text p={6} color="fg.muted">
            {manager
              ? "Todavía no hay documentos. Sube el primero con «Subir PDF»."
              : "No hay documentos de tus áreas todavía."}
          </Text>
        ) : (
          <Table.Root size="sm" interactive>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Documento</Table.ColumnHeader>
                <Table.ColumnHeader>Código</Table.ColumnHeader>
                <Table.ColumnHeader>Área</Table.ColumnHeader>
                <Table.ColumnHeader>Actualizado</Table.ColumnHeader>
                <Table.ColumnHeader />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {list.data?.map((doc) => (
                <Table.Row key={doc.doc_code}>
                  <Table.Cell>
                    <Text fontWeight="medium">{doc.doc_title}</Text>
                    <Text fontSize="xs" color="fg.subtle">
                      {[doc.doc_type, doc.doc_version].filter(Boolean).join(" · ")}
                    </Text>
                  </Table.Cell>
                  <Table.Cell fontFamily="mono" fontSize="xs">
                    {doc.doc_code}
                  </Table.Cell>
                  <Table.Cell>
                    <Badge variant="subtle">{areaOf(doc.required_scope)}</Badge>
                  </Table.Cell>
                  <Table.Cell fontSize="xs" color="fg.muted">
                    {doc.updated_at ? new Date(doc.updated_at).toLocaleDateString() : ""}
                  </Table.Cell>
                  <Table.Cell textAlign="end" whiteSpace="nowrap">
                    <IconButton
                      aria-label="Descargar el original"
                      size="xs"
                      variant="ghost"
                      onClick={() => void download(doc.doc_code)}
                    >
                      <FiDownload />
                    </IconButton>
                    {manager && (
                      <>
                        <IconButton
                          aria-label="Volver a indexar"
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            void act(async () =>
                              follow(
                                (
                                  await api<{ job_id: number }>(
                                    `/docs/${encodeURIComponent(doc.doc_code)}/reindex`,
                                    { method: "POST" },
                                  )
                                ).job_id,
                              ),
                            )
                          }
                        >
                          <FiRefreshCw />
                        </IconButton>
                        <DeleteButton
                          code={doc.doc_code}
                          onDelete={() =>
                            act(async () => {
                              await api(`/docs/${encodeURIComponent(doc.doc_code)}`, {
                                method: "DELETE",
                              });
                              await queries.invalidateQueries({ queryKey: ["docs"] });
                            })
                          }
                        />
                      </>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        )}
      </Box>
    </Stack>
  );
}

/**
 * Names the area a document belongs to from the permission that reads it
 *
 * @param   scope  Permission, as docs.<area>.read
 *
 * @return  The area
 */
function areaOf(scope: string): string {
  return scope.replace(/^docs\./, "").replace(/\.read$/, "");
}

/**
 * Picks a file extension for a download
 *
 * @param   type  Content type of the answer
 *
 * @return  The extension with its dot
 */
function extensionOf(type: string | null): string {
  return type?.includes("pdf") ? ".pdf" : type?.includes("markdown") ? ".md" : "";
}

/**
 * Loads a document: its markdown, with the frontmatter that names it, and optionally its original
 *
 * @param   props  What to do with the job the server queues
 *
 * @return  The button and its dialog
 */
function UploadButton({ onQueued }: { onQueued: (job: number) => void }) {
  const [open, setOpen] = useState(false);
  const [markdown, setMarkdown] = useState<File | null>(null);
  const [original, setOriginal] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (!markdown) {
      return;
    }
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append("document", markdown, markdown.name);
    if (original) {
      form.append("original", original, original.name);
    }
    try {
      const queued = await api<{ job_id: number }>("/docs", { method: "POST", body: form });
      onQueued(queued.job_id);
      setOpen(false);
      setMarkdown(null);
      setOriginal(null);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "No se pudo cargar el documento");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(details) => setOpen(details.open)}>
      <Dialog.Trigger asChild>
        <Button variant="outline" size="sm">
          <FiUpload /> Cargar Markdown
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content as="form" onSubmit={submit}>
            <Dialog.Header>
              <Dialog.Title>Cargar documento</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap={4}>
                <Field.Root required>
                  <Field.Label>Markdown del documento</Field.Label>
                  <Input
                    type="file"
                    accept=".md,text/markdown"
                    pt={1.5}
                    onChange={(event) => setMarkdown(event.target.files?.[0] ?? null)}
                  />
                  <Field.HelperText>
                    Con su encabezado: doc_code, doc_title, doc_version y area.
                  </Field.HelperText>
                </Field.Root>
                <Field.Root>
                  <Field.Label>Original (opcional)</Field.Label>
                  <Input
                    type="file"
                    accept="application/pdf,.pdf"
                    pt={1.5}
                    onChange={(event) => setOriginal(event.target.files?.[0] ?? null)}
                  />
                  <Field.HelperText>El PDF que las personas pueden descargar.</Field.HelperText>
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
              <Button type="submit" colorPalette="brand" loading={busy} disabled={!markdown}>
                Cargar
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/**
 * Follows a job until it ends, saying what happens while it runs
 *
 * @param   props  The job and what to do once it ends
 *
 * @return  A status line
 */
function JobStatus({ id, onSettled }: { id: number; onSettled: () => void }) {
  const queries = useQueryClient();
  const job = useQuery({
    queryKey: ["job", id],
    queryFn: () => api<Job>(`/docs/jobs/${id}`),
    // It stops once the job ends, or when it can no longer be read
    refetchInterval: (query) =>
      query.state.status === "error" ||
      query.state.data?.status === "done" ||
      query.state.data?.status === "failed"
        ? false
        : 2_000,
  });
  const status = job.isError ? "failed" : job.data?.status;
  const [dismissed, setDismissed] = useState(false);
  const finished = status === "done" || status === "failed";
  // The list shows the new document as soon as it is indexed, not when the notice is closed
  useEffect(() => {
    if (status === "done") {
      void queries.invalidateQueries({ queryKey: ["docs"] });
    }
  }, [status, queries]);

  if (dismissed) {
    return null;
  }

  return (
    <HStack
      bg={status === "failed" ? "bg.error" : status === "done" ? "bg.success" : "bg.subtle"}
      borderWidth="1px"
      rounded="panel"
      px={4}
      py={2}
      fontSize="sm"
      justify="space-between"
    >
      <HStack gap={2}>
        {!finished && <Spinner size="xs" />}
        <Text>
          {status === "done"
            ? `${job.data?.docCode} quedó indexado y ya se puede buscar.`
            : status === "failed"
              ? job.isError
                ? "No se pudo seguir el trabajo; revisa la lista en un momento."
                : `${job.data?.docCode} no se pudo indexar: ${job.data?.error ?? "error desconocido"}`
              : `Indexando ${job.data?.docCode ?? "el documento"}; tarda menos de un minuto.`}
        </Text>
      </HStack>
      {finished && (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            setDismissed(true);
            onSettled();
          }}
        >
          Cerrar
        </Button>
      )}
    </HStack>
  );
}

/**
 * Deletes a document after the person confirms it
 *
 * @param   props  The document and the deletion
 *
 * @return  The button and its confirmation
 */
function DeleteButton({ code, onDelete }: { code: string; onDelete: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  return (
    <Dialog.Root role="alertdialog" open={open} onOpenChange={(details) => setOpen(details.open)}>
      <Dialog.Trigger asChild>
        <IconButton aria-label="Borrar" size="xs" variant="ghost" colorPalette="red">
          <FiTrash2 />
        </IconButton>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>¿Borrar {code}?</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Text fontSize="sm">
                Sale de la búsqueda y se borran su markdown y su original. Para tenerlo otra vez hay
                que volver a cargarlo.
              </Text>
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button variant="outline">Cancelar</Button>
              </Dialog.ActionTrigger>
              {/* It closes once the document is gone, so the wait shows on the button */}
              <Button
                colorPalette="red"
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  await onDelete();
                  setBusy(false);
                  setOpen(false);
                }}
              >
                Borrar
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
