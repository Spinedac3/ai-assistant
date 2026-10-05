import { Badge, Box, Button, Field, HStack, Input, Spinner, Stack, Text } from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { FiCheck, FiRefreshCw, FiX } from "react-icons/fi";
import { ApiError, api } from "../api/http";

interface Setting {
  key: string;
  value: unknown;
}

interface Diagnostics {
  services: { name: string; ok: boolean; ms: number; detail: string | null }[];
  queues: {
    noticesPending: number;
    noticesFailed: number;
    documentsWaiting: number;
    documentsFailed: number;
  };
  errors: { event: string; message: string; at: string }[];
  failingTools: { tool: string; error: string | null; failures: number }[];
}

const FIELDS = [
  {
    key: "chat.model",
    label: "Modelo del chat",
    hint: "Mientras no se guarde uno, se usa el de la instalación. Se aplica desde el próximo mensaje.",
    placeholder: "claude-opus-5-5, sonnet…",
  },
  {
    key: "access.contact",
    label: "A quién pedir acceso",
    hint: "El asistente lo nombra cuando a alguien le falta un permiso.",
    placeholder: "mesa de ayuda, correo o extensión",
  },
] as const;

/**
 * What an administrator changes while the assistant runs
 *
 * @return  The page
 */
export function SettingsPage() {
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<Setting[]>("/admin/settings"),
  });

  return (
    <Stack gap={4} maxW="2xl">
      {settings.isLoading ? (
        <Spinner color="brand.solid" />
      ) : (
        FIELDS.map((field) => (
          <SettingField
            key={field.key}
            field={field}
            current={settings.data?.find((setting) => setting.key === field.key)?.value}
          />
        ))
      )}
    </Stack>
  );
}

/**
 * One setting with its own save, so each change is saved, checked and recorded apart
 *
 * @param   props  The setting and its stored value
 *
 * @return  The field
 */
function SettingField({ field, current }: { field: (typeof FIELDS)[number]; current: unknown }) {
  const queries = useQueryClient();
  const [value, setValue] = useState(typeof current === "string" ? current : "");
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setValue(typeof current === "string" ? current : ""), [current]);

  const save = async () => {
    setState(null);
    try {
      await api(`/admin/settings/${field.key}`, { method: "PUT", body: { value: value.trim() } });
      setState({ ok: true, text: "Guardado" });
      await queries.invalidateQueries({ queryKey: ["settings"] });
    } catch (failure) {
      setState({
        ok: false,
        text: failure instanceof ApiError ? failure.message : "No se pudo guardar",
      });
    }
  };

  return (
    <Box bg="bg.surface" borderWidth="1px" rounded="panel" p={4}>
      <Field.Root>
        <Field.Label>{field.label}</Field.Label>
        <HStack w="full">
          <Input
            value={value}
            placeholder={field.placeholder}
            onChange={(event) => setValue(event.target.value)}
          />
          <Button colorPalette="brand" disabled={!value.trim()} onClick={() => void save()}>
            Guardar
          </Button>
        </HStack>
        <Field.HelperText>{field.hint}</Field.HelperText>
      </Field.Root>
      {state && (
        <Text mt={2} fontSize="sm" color={state.ok ? "fg.success" : "fg.error"}>
          {state.text}
        </Text>
      )}
    </Box>
  );
}

/**
 * Whether each service answers, what waits in the queues, the latest errors and what fails most
 *
 * @return  The page
 */
export function DiagnosticsPage() {
  const report = useQuery({
    queryKey: ["diagnostics"],
    queryFn: () => api<Diagnostics>("/admin/diagnostics"),
    staleTime: 0,
  });
  const data = report.data;

  return (
    <Stack gap={4}>
      <HStack justify="space-between">
        <Text color="fg.muted" fontSize="sm">
          Una mirada rápida a lo que el asistente necesita para funcionar.
        </Text>
        <Button
          size="sm"
          variant="outline"
          loading={report.isFetching}
          onClick={() => void report.refetch()}
        >
          <FiRefreshCw /> Volver a revisar
        </Button>
      </HStack>
      {!data ? (
        <Spinner color="brand.solid" />
      ) : (
        <>
          <Box bg="bg.surface" borderWidth="1px" rounded="panel" p={4}>
            <Stack gap={2}>
              {data.services.map((service) => (
                <HStack key={service.name} gap={3} fontSize="sm">
                  <Box color={service.ok ? "fg.success" : "fg.error"}>
                    {service.ok ? <FiCheck /> : <FiX />}
                  </Box>
                  <Text fontWeight="medium" minW="40">
                    {service.name}
                  </Text>
                  <Text color="fg.muted" flex={1} lineClamp={1}>
                    {service.detail ?? (service.ok ? "responde" : "")}
                  </Text>
                  <Text fontSize="xs" color="fg.subtle" fontVariantNumeric="tabular-nums">
                    {service.ms} ms
                  </Text>
                </HStack>
              ))}
            </Stack>
          </Box>
          <HStack wrap="wrap" gap={3}>
            <Queue label="Avisos por enviar" value={data.queues.noticesPending} />
            <Queue label="Avisos fallidos (24 h)" value={data.queues.noticesFailed} bad />
            <Queue label="Documentos por indexar" value={data.queues.documentsWaiting} />
            <Queue label="Indexaciones fallidas (24 h)" value={data.queues.documentsFailed} bad />
          </HStack>
          <Box bg="bg.surface" borderWidth="1px" rounded="panel" p={4}>
            <Text fontWeight="semibold" mb={2}>
              Herramientas que más fallaron (24 h)
            </Text>
            {data.failingTools.length === 0 ? (
              <Text fontSize="sm" color="fg.muted">
                Ninguna falló.
              </Text>
            ) : (
              data.failingTools.map((tool) => (
                <HStack key={`${tool.tool}:${tool.error}`} fontSize="sm" justify="space-between">
                  <Text fontFamily="mono">{tool.tool}</Text>
                  <Text color="fg.muted">
                    {tool.failures} × {tool.error ?? "error"}
                  </Text>
                </HStack>
              ))
            )}
          </Box>
          <Box bg="bg.surface" borderWidth="1px" rounded="panel" p={4}>
            <Text fontWeight="semibold" mb={2}>
              Últimos errores
            </Text>
            {data.errors.length === 0 ? (
              <Text fontSize="sm" color="fg.muted">
                No hay errores registrados.
              </Text>
            ) : (
              <Stack gap={2}>
                {data.errors.map((error) => (
                  <Stack key={`${error.at}:${error.event}`} gap={0} fontSize="sm">
                    <HStack gap={2}>
                      <Badge size="sm" colorPalette="red" variant="subtle" fontFamily="mono">
                        {error.event}
                      </Badge>
                      <Text fontSize="xs" color="fg.subtle">
                        {new Date(error.at).toLocaleString()}
                      </Text>
                    </HStack>
                    <Text>{error.message}</Text>
                  </Stack>
                ))}
              </Stack>
            )}
          </Box>
        </>
      )}
    </Stack>
  );
}

/**
 * One count of a queue, red when it counts failures
 *
 * @param   props  Label, count and whether it counts failures
 *
 * @return  The count
 */
function Queue({ label, value, bad = false }: { label: string; value: number; bad?: boolean }) {
  return (
    <Box bg="bg.surface" borderWidth="1px" rounded="panel" px={4} py={3} minW="44">
      <Text fontSize="xs" color="fg.muted">
        {label}
      </Text>
      <Text fontSize="xl" fontWeight="semibold" color={bad && value > 0 ? "fg.error" : undefined}>
        {value}
      </Text>
    </Box>
  );
}
