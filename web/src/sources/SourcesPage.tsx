import {
  Badge,
  Box,
  Button,
  Dialog,
  Field,
  HStack,
  IconButton,
  Input,
  NativeSelect,
  Portal,
  Spinner,
  Stack,
  Switch,
  Table,
  Text,
} from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { FiActivity, FiEdit2, FiPlus, FiTrash2 } from "react-icons/fi";
import { ApiError, api } from "../api/http";
import { TimeZoneSelect } from "../shell/TimeZoneSelect";

interface Source {
  code: string;
  name: string;
  engine: "postgres" | "mysql" | "mssql";
  host: string;
  port: number;
  database: string;
  username: string;
  timeZone: string | null;
  tls: boolean;
}

const ENGINES = { postgres: "PostgreSQL", mysql: "MySQL", mssql: "SQL Server" } as const;

/**
 * The databases the tools read: registering, testing and removing them
 *
 * @return  The page
 */
export function SourcesPage() {
  const queries = useQueryClient();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const list = useQuery({ queryKey: ["sources"], queryFn: () => api<Source[]>("/admin/sources") });

  const test = async (code: string) => {
    setMessage(null);
    try {
      const result = await api<{
        ok: boolean;
        error?: string;
        message?: string;
        abilities?: string[];
      }>(`/admin/sources/${code}/test`, { method: "POST" });
      setMessage(
        result.ok
          ? { ok: true, text: `${code}: la conexión funciona y el usuario solo puede leer.` }
          : {
              ok: false,
              text:
                result.error === "not_read_only"
                  ? `${code}: el usuario puede escribir (${result.abilities?.join(", ")}); usa uno de solo lectura.`
                  : `${code}: ${result.message ?? "no se pudo conectar"}`,
            },
      );
    } catch (failure) {
      setMessage({
        ok: false,
        text: failure instanceof ApiError ? failure.message : "No se pudo probar",
      });
    }
  };

  const remove = async (code: string) => {
    setMessage(null);
    try {
      await api(`/admin/sources/${code}`, { method: "DELETE" });
      await queries.invalidateQueries({ queryKey: ["sources"] });
    } catch (failure) {
      setMessage({
        ok: false,
        text: failure instanceof ApiError ? failure.message : "No se pudo borrar",
      });
    }
  };

  return (
    <Stack gap={4}>
      <HStack justify="space-between">
        <Text color="fg.muted" fontSize="sm">
          Las bases de datos que leen las herramientas. Cada una se conecta con un usuario de solo
          lectura; el asistente lo verifica antes de guardarla.
        </Text>
        <SourceForm onSaved={() => void queries.invalidateQueries({ queryKey: ["sources"] })} />
      </HStack>
      {message && (
        <Text role="status" fontSize="sm" color={message.ok ? "fg.success" : "fg.error"}>
          {message.text}
        </Text>
      )}
      <Box bg="bg.surface" borderWidth="1px" rounded="panel" overflow="auto">
        {list.isLoading ? (
          <Spinner m={6} color="brand.solid" />
        ) : list.data?.length === 0 ? (
          <Text p={6} color="fg.muted">
            Todavía no hay fuentes. Registra la primera con «Nueva fuente».
          </Text>
        ) : (
          <Table.Root size="sm">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Fuente</Table.ColumnHeader>
                <Table.ColumnHeader>Motor</Table.ColumnHeader>
                <Table.ColumnHeader>Servidor</Table.ColumnHeader>
                <Table.ColumnHeader>Zona horaria</Table.ColumnHeader>
                <Table.ColumnHeader />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {list.data?.map((source) => (
                <Table.Row key={source.code}>
                  <Table.Cell>
                    <Text fontWeight="medium">{source.name}</Text>
                    <Text fontSize="xs" fontFamily="mono" color="fg.subtle">
                      {source.code}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge variant="subtle">{ENGINES[source.engine]}</Badge>
                  </Table.Cell>
                  <Table.Cell fontFamily="mono" fontSize="xs">
                    {source.username}@{source.host}:{source.port}/{source.database}
                    {!source.tls && (
                      <Badge ml={2} colorPalette="orange" variant="subtle">
                        sin TLS
                      </Badge>
                    )}
                  </Table.Cell>
                  <Table.Cell fontSize="sm">{source.timeZone ?? "la del asistente"}</Table.Cell>
                  <Table.Cell textAlign="end" whiteSpace="nowrap">
                    <IconButton
                      aria-label="Probar la conexión"
                      size="xs"
                      variant="ghost"
                      onClick={() => void test(source.code)}
                    >
                      <FiActivity />
                    </IconButton>
                    <SourceForm
                      existing={source}
                      onSaved={() => void queries.invalidateQueries({ queryKey: ["sources"] })}
                    />
                    <IconButton
                      aria-label="Borrar"
                      size="xs"
                      variant="ghost"
                      colorPalette="red"
                      onClick={() => {
                        if (window.confirm(`¿Borrar la fuente ${source.code}?`)) {
                          void remove(source.code);
                        }
                      }}
                    >
                      <FiTrash2 />
                    </IconButton>
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
 * Registers a source, or replaces one: the password is always asked again, since it is never
 * shown back
 *
 * @param   props  The source being replaced, if any, and what to do once saved
 *
 * @return  The button and its dialog
 */
function SourceForm({ existing, onSaved }: { existing?: Source; onSaved: () => void }) {
  const blank = {
    code: "",
    name: "",
    engine: "postgres" as Source["engine"],
    host: "",
    port: "",
    database: "",
    username: "",
    password: "",
    timeZone: "",
    tls: true,
  };
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = () => {
    setForm(
      existing
        ? {
            ...existing,
            port: String(existing.port),
            password: "",
            timeZone: existing.timeZone ?? "",
          }
        : blank,
    );
    setError(null);
  };
  const set = (field: keyof typeof blank) => (value: string | boolean) =>
    setForm((current) => ({ ...current, [field]: value }));

  const save = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/admin/sources", {
        method: "POST",
        body: {
          code: form.code,
          name: form.name,
          engine: form.engine,
          host: form.host,
          ...(form.port ? { port: Number(form.port) } : {}),
          database: form.database,
          username: form.username,
          password: form.password,
          timeZone: form.timeZone || null,
          tls: form.tls,
          // Only changing an existing source may replace it
          ...(existing ? { replace: true } : {}),
        },
      });
      setOpen(false);
      onSaved();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "No se pudo guardar la fuente");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(details) => {
        setOpen(details.open);
        if (details.open) {
          start();
        }
      }}
    >
      <Dialog.Trigger asChild>
        {existing ? (
          <IconButton aria-label="Cambiar" size="xs" variant="ghost">
            <FiEdit2 />
          </IconButton>
        ) : (
          <Button colorPalette="brand" size="sm">
            <FiPlus /> Nueva fuente
          </Button>
        )}
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content as="form" onSubmit={save} maxW="lg">
            <Dialog.Header>
              <Dialog.Title>{existing ? `Cambiar ${existing.code}` : "Nueva fuente"}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap={3}>
                <HStack gap={3} align="start">
                  <Field.Root required>
                    <Field.Label>Código</Field.Label>
                    <Input
                      value={form.code}
                      disabled={existing !== undefined}
                      onChange={(event) => set("code")(event.target.value)}
                      placeholder="ventas"
                      fontFamily="mono"
                    />
                    <Field.HelperText>Minúsculas, números, guion.</Field.HelperText>
                  </Field.Root>
                  <Field.Root required>
                    <Field.Label>Nombre</Field.Label>
                    <Input
                      value={form.name}
                      onChange={(event) => set("name")(event.target.value)}
                    />
                  </Field.Root>
                </HStack>
                <HStack gap={3} align="start">
                  <Field.Root required>
                    <Field.Label>Motor</Field.Label>
                    <NativeSelect.Root>
                      <NativeSelect.Field
                        value={form.engine}
                        onChange={(event) => set("engine")(event.target.value)}
                      >
                        {Object.entries(ENGINES).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </NativeSelect.Field>
                    </NativeSelect.Root>
                  </Field.Root>
                  <Field.Root required>
                    <Field.Label>Servidor</Field.Label>
                    <Input
                      value={form.host}
                      onChange={(event) => set("host")(event.target.value)}
                    />
                  </Field.Root>
                  <Field.Root maxW="28">
                    <Field.Label>Puerto</Field.Label>
                    <Input
                      inputMode="numeric"
                      value={form.port}
                      onChange={(event) => set("port")(event.target.value)}
                      placeholder="el del motor"
                    />
                  </Field.Root>
                </HStack>
                <Field.Root required>
                  <Field.Label>Base de datos</Field.Label>
                  <Input
                    value={form.database}
                    onChange={(event) => set("database")(event.target.value)}
                  />
                </Field.Root>
                <HStack gap={3} align="start">
                  <Field.Root required>
                    <Field.Label>Usuario</Field.Label>
                    <Input
                      value={form.username}
                      autoComplete="off"
                      onChange={(event) => set("username")(event.target.value)}
                    />
                    <Field.HelperText>De solo lectura.</Field.HelperText>
                  </Field.Root>
                  <Field.Root required>
                    <Field.Label>Contraseña</Field.Label>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      value={form.password}
                      onChange={(event) => set("password")(event.target.value)}
                    />
                    {existing && (
                      <Field.HelperText>Se pide otra vez al cambiarla.</Field.HelperText>
                    )}
                  </Field.Root>
                </HStack>
                <HStack gap={3} align="end">
                  <Field.Root>
                    <Field.Label>Zona horaria de los datos</Field.Label>
                    <TimeZoneSelect
                      value={form.timeZone}
                      onChange={set("timeZone")}
                      inherited="el asistente"
                    />
                  </Field.Root>
                  <Switch.Root
                    checked={form.tls}
                    onCheckedChange={(details) => set("tls")(details.checked)}
                    pb={2}
                  >
                    <Switch.HiddenInput />
                    <Switch.Control />
                    <Switch.Label>TLS</Switch.Label>
                  </Switch.Root>
                </HStack>
                <Text fontSize="xs" color="fg.muted">
                  TLS cifra la conexión con la base. Apágalo solo para una base local sin
                  certificado.
                </Text>
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
              <Button type="submit" colorPalette="brand" loading={busy} loadingText="Verificando">
                Guardar
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
