import {
  Box,
  Button,
  Flex,
  HStack,
  IconButton,
  Spinner,
  Stack,
  Text,
  Textarea,
} from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { FiCheck, FiPaperclip, FiPlus, FiSend, FiSquare, FiStar, FiX } from "react-icons/fi";
import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import { NavLink, useNavigate, useParams } from "react-router";
import remarkGfm from "remark-gfm";
import { ApiError, api } from "../api/http";
import { type ChatMessage, type ConversationSummary, streamTurn, toolLabel } from "./api";

interface ToolStep {
  id: string;
  name: string;
  state: "running" | "ok" | "failed";
}

interface Draft {
  question: string;
  text: string;
  tools: ToolStep[];
}

interface Conversation {
  id: number;
  title: string | null;
  messages: ChatMessage[];
}

const PULSE = "pulse 1.5s ease-in-out infinite";

// The note a message carries so the model finds the PDF; shown to the person as a chip instead
const ATTACHMENT_NOTE = /\n\n\[PDF adjunto «(.+?)», file_id: [0-9a-f-]+\. Léelo con read_pdf\.\]$/;

/**
 * Opens the chat on its conversation, a fresh page for each one, so a turn in flight never draws
 * into another conversation
 *
 * @return  The page
 */
export function ChatRoute() {
  const { id } = useParams();
  return <ChatPage key={id ?? "new"} conversationId={id ? Number(id) : null} />;
}

/**
 * The internal chat: a person's conversations on the left and the open one on the right, with
 * the tools the assistant uses shown while they run
 *
 * @param   props  The open conversation, or null for a new one
 *
 * @return  The page
 */
function ChatPage({ conversationId }: { conversationId: number | null }) {
  const navigate = useNavigate();
  const queries = useQueryClient();
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState<{ fileId: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const stop = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  // Leaving the page stops the turn that was answering on it
  useEffect(() => () => stop.current?.abort(), []);

  const list = useQuery({
    queryKey: ["conversations"],
    queryFn: () => api<ConversationSummary[]>("/chat/conversations"),
  });
  const open = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => api<Conversation>(`/chat/conversations/${conversationId}`),
    enabled: conversationId !== null,
  });

  const messages = conversationId ? (open.data?.messages ?? []) : [];
  const shown = `${messages.length}:${draft?.text.length ?? 0}:${draft?.tools.length ?? 0}`;
  useEffect(() => {
    if (shown) {
      bottom.current?.scrollIntoView({ block: "end" });
    }
  }, [shown]);

  const attach = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    setUploading(true);
    setError(null);
    const form = new FormData();
    form.append("file", file, file.name);
    try {
      setAttached(
        await api<{ fileId: string; name: string }>("/chat/upload", { method: "POST", body: form }),
      );
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "No se pudo adjuntar el PDF");
    } finally {
      setUploading(false);
      if (picker.current) {
        picker.current.value = "";
      }
    }
  };

  const update = (change: (current: Draft) => Draft) =>
    setDraft((current) => (current ? change(current) : current));

  const send = async () => {
    const typed = input.trim();
    // The model learns the file from the message itself, and reads it with read_pdf
    const question = attached
      ? `${typed || "¿Qué dice este documento?"}\n\n[PDF adjunto «${attached.name}», file_id: ${attached.fileId}. Léelo con read_pdf.]`
      : typed;
    if (!question || draft) {
      return;
    }
    setInput("");
    setAttached(null);
    setError(null);
    setDraft({ question, text: "", tools: [] });
    const controller = new AbortController();
    stop.current = controller;
    let target = conversationId;
    let finished = false;
    try {
      for await (const event of streamTurn(question, conversationId, controller.signal)) {
        if (event.type === "start") {
          target = event.conversationId;
        } else if (event.type === "delta") {
          update((current) => ({ ...current, text: current.text + event.text }));
        } else if (event.type === "tool_call_pending") {
          update((current) => ({
            ...current,
            tools: [...current.tools, { id: event.id, name: event.name, state: "running" }],
          }));
        } else if (event.type === "tool_result") {
          update((current) => ({
            ...current,
            tools: current.tools.map((tool) =>
              tool.id === event.id ? { ...tool, state: event.ok ? "ok" : "failed" } : tool,
            ),
          }));
        } else if (event.type === "done") {
          finished = true;
          // The server may have answered on a second attempt; its final text is the one that counts
          update((current) => ({ ...current, text: event.text }));
        } else if (event.type === "error") {
          finished = true;
          setError(event.message);
        }
      }
      if (!finished && !controller.signal.aborted) {
        setError("Se cortó la conexión antes de terminar la respuesta; vuelve a intentarlo");
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(
          failure instanceof ApiError
            ? failure.message
            : "Se cortó la conexión; vuelve a intentarlo",
        );
      }
    } finally {
      stop.current = null;
    }
    if (controller.signal.aborted) {
      return;
    }

    // The stored conversation replaces the draft only once it is loaded, so nothing flickers
    await queries.invalidateQueries({ queryKey: ["conversations"] });
    if (target) {
      await queries
        .query({
          queryKey: ["conversation", target],
          queryFn: () => api<Conversation>(`/chat/conversations/${target}`),
        })
        .catch(() => undefined);
      if (target !== conversationId) {
        navigate(`/chat/${target}`);
        return;
      }
    }
    setDraft(null);
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter while an input method is composing a character belongs to that composition
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <Flex h="full" gap={4} minH={0}>
      <Stack
        w="260px"
        flexShrink={0}
        bg="bg.surface"
        borderWidth="1px"
        rounded="panel"
        p={2}
        gap={1}
        overflow="auto"
      >
        <Button
          size="sm"
          variant="subtle"
          colorPalette="brand"
          onClick={() => navigate("/chat")}
          mb={1}
        >
          <FiPlus /> Nueva conversación
        </Button>
        {list.data?.length === 0 && (
          <Text fontSize="sm" color="fg.muted" p={3}>
            Todavía no hay conversaciones. Escribe tu primera pregunta a la derecha.
          </Text>
        )}
        {list.data?.map((conversation) => (
          <NavLink key={conversation.id} to={`/chat/${conversation.id}`}>
            {({ isActive }) => (
              <Box
                px={3}
                py={2}
                rounded="control"
                bg={isActive ? "brand.subtle" : undefined}
                _hover={{ bg: isActive ? undefined : "bg.muted" }}
              >
                <Text fontSize="sm" fontWeight={isActive ? "semibold" : "normal"} lineClamp={1}>
                  {conversation.title ?? "Sin título"}
                </Text>
                <Text fontSize="xs" color="fg.subtle">
                  {new Date(conversation.lastMessageAt).toLocaleString()}
                </Text>
              </Box>
            )}
          </NavLink>
        ))}
      </Stack>

      <Flex direction="column" flex={1} minW={0} bg="bg.surface" borderWidth="1px" rounded="panel">
        <Stack flex={1} overflow="auto" p={5} gap={4}>
          {conversationId && open.isLoading && <Spinner color="brand.solid" />}
          {!conversationId && !draft && (
            <Text color="fg.muted">
              Pregunta lo que necesites; verás las herramientas que el asistente usa para responder.
            </Text>
          )}
          {messages.map((message) => (
            <Bubble key={message.id} message={message} />
          ))}
          {draft && (
            <>
              <Bubble message={{ id: 0, role: "user", content: draft.question, createdAt: "" }} />
              <Stack gap={2}>
                {draft.tools.map((tool) => (
                  <HStack key={tool.id} fontSize="sm" color="fg.muted" gap={2}>
                    {tool.state === "running" ? (
                      <Spinner size="xs" />
                    ) : tool.state === "ok" ? (
                      <FiCheck />
                    ) : (
                      <FiX />
                    )}
                    <Text animation={tool.state === "running" ? PULSE : undefined}>
                      {toolLabel(tool.name)}
                    </Text>
                  </HStack>
                ))}
                {draft.text ? (
                  <Answer text={draft.text} />
                ) : (
                  draft.tools.length === 0 &&
                  !error && (
                    <Text fontSize="sm" color="fg.subtle" animation={PULSE}>
                      Pensando…
                    </Text>
                  )
                )}
              </Stack>
            </>
          )}
          {error && (
            <Text role="alert" fontSize="sm" color="fg.error">
              {error}
            </Text>
          )}
          <div ref={bottom} />
        </Stack>
        {attached && (
          <HStack px={3} pt={3} gap={2} fontSize="sm">
            <FiPaperclip />
            <Text lineClamp={1}>{attached.name}</Text>
            <IconButton
              aria-label="Quitar el PDF"
              size="2xs"
              variant="ghost"
              onClick={() => setAttached(null)}
            >
              <FiX />
            </IconButton>
          </HStack>
        )}
        <HStack p={3} borderTopWidth="1px" align="end">
          <input
            ref={picker}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            onChange={(event) => void attach(event.target.files?.[0])}
          />
          <IconButton
            aria-label="Adjuntar un PDF"
            variant="ghost"
            loading={uploading}
            disabled={draft !== null}
            onClick={() => picker.current?.click()}
          >
            <FiPaperclip />
          </IconButton>
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKey}
            placeholder="Escribe tu pregunta; Mayúsculas + Enter para otra línea"
            autoresize
            maxH="40"
            bg="bg.field"
            rows={1}
          />
          {draft ? (
            <IconButton
              aria-label="Detener"
              variant="outline"
              onClick={() => stop.current?.abort()}
            >
              <FiSquare />
            </IconButton>
          ) : (
            <IconButton
              aria-label="Enviar"
              colorPalette="brand"
              onClick={() => void send()}
              disabled={!input.trim() && !attached}
            >
              <FiSend />
            </IconButton>
          )}
        </HStack>
      </Flex>
    </Flex>
  );
}

// Links of an answer open apart, and one to another site says which site it is before anyone
// follows it: the text of an answer may come from data or a document no one checked
const LINKS: Components = {
  a: ({ href, children }) => {
    const target = href ? new URL(href, window.location.href) : null;
    const foreign = target !== null && target.origin !== window.location.origin;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
        {foreign && ` (${target.host})`}
      </a>
    );
  },
};

/**
 * An answer of the assistant, rendered from its markdown
 *
 * @param   props  The text
 *
 * @return  The answer
 */
function Answer({ text }: { text: string }) {
  return (
    <Box className="markdown" fontSize="sm">
      <Markdown remarkPlugins={[remarkGfm]} components={LINKS}>
        {text}
      </Markdown>
    </Box>
  );
}

/**
 * One message: the person's on the right, the assistant's as rendered markdown with its rating
 *
 * @param   props  The message
 *
 * @return  The bubble
 */
function Bubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    const note = message.content.match(ATTACHMENT_NOTE);
    return (
      <Stack alignSelf="flex-end" maxW="75%" align="flex-end" gap={1}>
        {note && (
          <HStack fontSize="xs" color="fg.muted" gap={1}>
            <FiPaperclip />
            <Text>{note[1]}</Text>
          </HStack>
        )}
        <Box bg="brand.subtle" px={4} py={2} rounded="panel" fontSize="sm" whiteSpace="pre-wrap">
          {note ? message.content.slice(0, note.index) : message.content}
        </Box>
      </Stack>
    );
  }

  return (
    <Stack gap={1}>
      <Answer text={message.content} />
      {message.id > 0 && <Rating messageId={message.id} />}
    </Stack>
  );
}

/**
 * Lets the person rate an answer from one to five stars; a low one asks what went wrong, as the
 * server requires
 *
 * @param   props  The answer
 *
 * @return  The stars, and the comment when it is asked for
 */
function Rating({ messageId }: { messageId: number }) {
  const [stars, setStars] = useState(0);
  const [pending, setPending] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

  const rate = async (value: number, text?: string) => {
    setError(null);
    try {
      await api(`/chat/messages/${messageId}/rate`, {
        method: "POST",
        body: { stars: value, ...(text ? { comment: text } : {}) },
      });
      setStars(value);
      setPending(null);
      setComment("");
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "No se pudo guardar la nota");
    }
  };

  return (
    <Stack gap={1}>
      <HStack gap={0}>
        {[1, 2, 3, 4, 5].map((value) => (
          <IconButton
            key={value}
            aria-label={`${value} de 5`}
            size="2xs"
            variant="ghost"
            color={value <= (pending ?? stars) ? "brand.solid" : "fg.subtle"}
            onClick={() => (value <= 2 ? setPending(value) : void rate(value))}
          >
            <FiStar fill={value <= (pending ?? stars) ? "currentColor" : "none"} />
          </IconButton>
        ))}
      </HStack>
      {pending !== null && (
        <HStack maxW="lg" align="end">
          <Textarea
            size="sm"
            bg="bg.field"
            rows={2}
            placeholder="¿Qué estuvo mal en la respuesta?"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
          <Button
            size="sm"
            colorPalette="brand"
            disabled={!comment.trim()}
            onClick={() => void rate(pending, comment.trim())}
          >
            Enviar
          </Button>
        </HStack>
      )}
      {error && (
        <Text role="alert" fontSize="xs" color="fg.error">
          {error}
        </Text>
      )}
    </Stack>
  );
}
