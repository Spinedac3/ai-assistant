import { Text } from "@chakra-ui/react";
import { type MouseEvent, type ReactNode, useState } from "react";
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

/**
 * A link to an Excel of the panel: a plain link cannot carry the session, so the panel fetches it
 *
 * @param   props  Path and text of the link
 *
 * @return  The link
 */
function ExportLink({ path, children }: { path: string; children: ReactNode }) {
  const [problem, setProblem] = useState<string | null>(null);
  const open = (event: MouseEvent) => {
    event.preventDefault();
    setProblem(null);
    downloadFile(path).catch((error: Error) => setProblem(error.message));
  };

  return (
    <>
      <a href={path} onClick={open}>
        {children}
      </a>
      {problem && (
        <Text as="span" color="fg.error" fontSize="sm">
          {` (${problem})`}
        </Text>
      )}
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
      return <ExportLink path={target.pathname}>{children}</ExportLink>;
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
