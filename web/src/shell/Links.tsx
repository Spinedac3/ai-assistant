import { Box, Button, Dialog, Portal, Spinner, Table, Tabs, Text } from "@chakra-ui/react";
import { useState } from "react";
import { FiDownload, FiEye } from "react-icons/fi";
import type { Components } from "react-markdown";
import { request } from "../api/http";

/**
 * Downloads a file the server gives to the person's session, under the name the server sends
 *
 * @param   path  Path of the file
 */
export async function downloadFile(path: string): Promise<void> {
  const response = await request(path);
  if (!response.ok) {
    throw new Error("El archivo ya no está disponible; vuelve a pedir los datos");
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "datos.xlsx";
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Tells whether a link is an Excel of this panel opened with the session, not a signed one
 *
 * @param   target  Parsed link
 *
 * @return  Whether the panel downloads it itself
 */
export function isPanelExport(target: URL): boolean {
  return (
    target.origin === window.location.origin &&
    /^\/exports\/[0-9a-f-]{36}$/.test(target.pathname) &&
    !target.searchParams.has("sig")
  );
}

interface Preview {
  sheets: { name: string; columns: string[]; rows: unknown[][]; total: number }[];
}

/**
 * Writes a cell of the preview as the Excel shows it: amounts with thousands, yes or no
 *
 * @param   value  Value
 *
 * @return  The text
 */
function shown(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "sí" : "no";
  }
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? String(value)
      : value.toLocaleString("es", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  return String(value);
}

/**
 * The Excel of an answer: a look at its sheets without downloading it, and the download
 *
 * @param   props  Path of the file
 *
 * @return  The buttons and the preview
 */
export function ExportActions({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const look = async () => {
    setProblem(null);
    if (preview) {
      return;
    }
    const response = await request(`${path}/preview`);
    if (!response.ok) {
      // Files made before previews existed, or already expired, have none
      setProblem(
        "Este archivo no tiene vista previa (se generó antes de que existiera o ya venció). Puedes descargarlo o pedir los datos de nuevo.",
      );
      return;
    }
    setPreview((await response.json()) as Preview);
  };

  return (
    <>
      <Button
        size="2xs"
        variant="outline"
        mx={1}
        onClick={() => {
          setOpen(true);
          void look();
        }}
      >
        <FiEye /> Ver
      </Button>
      <Button
        size="2xs"
        variant="outline"
        colorPalette="brand"
        onClick={() => downloadFile(path).catch((error: Error) => setProblem(error.message))}
      >
        <FiDownload /> Descargar Excel
      </Button>
      {problem && (
        <Text as="span" color="fg.error" fontSize="sm">
          {` ${problem}`}
        </Text>
      )}
      <Dialog.Root open={open} onOpenChange={(details) => setOpen(details.open)} size="xl">
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="6xl">
              <Dialog.Header>
                <Dialog.Title>Vista previa del Excel</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                {!preview ? (
                  problem ? (
                    <Text color="fg.error">{problem}</Text>
                  ) : (
                    <Spinner color="brand.solid" />
                  )
                ) : (
                  <Tabs.Root defaultValue={preview.sheets[0]?.name} size="sm" variant="line">
                    <Tabs.List>
                      {preview.sheets.map((sheet) => (
                        <Tabs.Trigger key={sheet.name} value={sheet.name}>
                          {sheet.name} ({sheet.total})
                        </Tabs.Trigger>
                      ))}
                    </Tabs.List>
                    {preview.sheets.map((sheet) => (
                      <Tabs.Content key={sheet.name} value={sheet.name}>
                        <Box maxH="60vh" overflow="auto" borderWidth="1px" rounded="md">
                          <Table.Root size="sm" stickyHeader>
                            <Table.Header>
                              <Table.Row>
                                {sheet.columns.map((column) => (
                                  <Table.ColumnHeader key={column}>{column}</Table.ColumnHeader>
                                ))}
                              </Table.Row>
                            </Table.Header>
                            <Table.Body>
                              {sheet.rows.map((row, index) => (
                                // biome-ignore lint/suspicious/noArrayIndexKey: rows of a fixed preview never move
                                <Table.Row key={index}>
                                  {sheet.columns.map((column, col) => (
                                    <Table.Cell
                                      key={column}
                                      textAlign={typeof row[col] === "number" ? "end" : "start"}
                                    >
                                      {shown(row[col])}
                                    </Table.Cell>
                                  ))}
                                </Table.Row>
                              ))}
                            </Table.Body>
                          </Table.Root>
                        </Box>
                        {sheet.rows.length < sheet.total && (
                          <Text fontSize="xs" color="fg.muted" mt={2}>
                            Se ven {sheet.rows.length} de {sheet.total} filas; el Excel las trae
                            todas.
                          </Text>
                        )}
                      </Tabs.Content>
                    ))}
                  </Tabs.Root>
                )}
              </Dialog.Body>
              <Dialog.Footer>
                <Button
                  colorPalette="brand"
                  onClick={() =>
                    downloadFile(path).catch((error: Error) => setProblem(error.message))
                  }
                >
                  <FiDownload /> Descargar Excel
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}

// Links of an answer open apart, and one to another site says which site it is before anyone
// follows it: the text of an answer may come from data or a document no one checked
export const LINKS: Components = {
  a: ({ href, children }) => {
    // A link that does not parse is shown as its text, never as a page that fails to render
    if (!href || !URL.canParse(href, window.location.href)) {
      return <span>{children}</span>;
    }
    const target = new URL(href, window.location.href);
    if (isPanelExport(target)) {
      return <ExportActions path={target.pathname} />;
    }
    const foreign =
      target.protocol.startsWith("http") &&
      target.host !== "" &&
      target.origin !== window.location.origin;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
        {foreign && ` (${target.host})`}
      </a>
    );
  },
};
