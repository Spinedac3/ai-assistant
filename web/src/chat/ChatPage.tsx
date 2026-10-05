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

const PULSE = "pulse 1.5s ease-in-out infinite";

/**
 * The internal chat: a person's conversations on the left and the open one on the right, with
 * the tools the assistant uses shown while they run
 *
 * @return  The page
 */
export function ChatPage() {
  const { id } = useParams();
  const conversationId = id ? Number(id) : null;
  const navigate = useNavigate();
  const queries = useQueryClient();
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState<{ fileId: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

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
  const stop = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const list = useQuery({
    queryKey: ["conversations"],
    queryFn: () => api<ConversationSummary[]>("/chat/conversations"),
  });
  const open = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () =>
      api<{ id: number; title: string | null; messages: ChatMessage[] }>(
        `/chat/conversations/${conversationId}`,
      ),
    enabled: conversationId !== null,
  });

  const messages = conversationId ? (open.data?.messages ?? []) : [];
  const shown = `${messages.length}:${draft?.text.length ?? 0}:${draft?.tools.length ?? 0}`;
  useEffect(() => {
    if (shown) {
      bottom.current?.scrollIntoView({ block: "end" });
    }
  }, [shown]);

  const update = (change: (current: Draft) => Draft) =>
    setDraft((current) => (current ? change(current) : current));

  const send = async () => {
    const typed = input.trim();
    // The model learns the file from the message itself, and reads it with read_pdf
    const question = attached
      ? `${typed || "¿Qué dice este documento?"}

[PDF adjunto «${attached.name}», file_id: ${attached.fileId}. Léelo con read_pdf.]`
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
        } else if (event.type === "error") {
          setError(event.message);
        }
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
      await queries.invalidateQueries({ queryKey: ["conversations"] });
      if (target) {
        await queries.invalidateQueries({ queryKey: ["conversation", target] });
        if (target !== conversationId) {
          navigate(`/chat/${target}`);
        }
      }
      setDraft(null);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
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
                  <Box className="markdown" fontSize="sm">
                    <Markdown remarkPlugins={[remarkGfm]}>{draft.text}</Markdown>
                  </Box>
                ) : (
                  draft.tools.length === 0 && (
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

/**
 * One message: the person's on the right, the assistant's as rendered markdown with its rating
 *
 * @param   props  The message
 *
 * @return  The bubble
 */
function Bubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <Box
        alignSelf="flex-end"
        maxW="75%"
        bg="brand.subtle"
        px={4}
        py={2}
        rounded="panel"
        fontSize="sm"
        whiteSpace="pre-wrap"
      >
        {message.content}
      </Box>
    );
  }

  return (
    <Stack gap={1}>
      <Box className="markdown" fontSize="sm">
        <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
      </Box>
      {message.id > 0 && <Rating messageId={message.id} />}
    </Stack>
  );
}

/**
 * Lets the person rate an answer from one to five stars
 *
 * @param   props  The answer
 *
 * @return  The stars
 */
function Rating({ messageId }: { messageId: number }) {
  const [stars, setStars] = useState(0);
  const rate = async (value: number) => {
    setStars(value);
    await api(`/chat/messages/${messageId}/rate`, { method: "POST", body: { stars: value } }).catch(
      () => setStars(0),
    );
  };

  return (
    <HStack gap={0}>
      {[1, 2, 3, 4, 5].map((value) => (
        <IconButton
          key={value}
          aria-label={`${value} de 5`}
          size="2xs"
          variant="ghost"
          color={value <= stars ? "brand.solid" : "fg.subtle"}
          onClick={() => void rate(value)}
        >
          <FiStar fill={value <= stars ? "currentColor" : "none"} />
        </IconButton>
      ))}
    </HStack>
  );
}
