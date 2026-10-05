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
import { type ReactNode, useState } from "react";
import { FiEdit2, FiKey, FiMail, FiPlus, FiTrash2, FiX } from "react-icons/fi";
import { ApiError, api } from "../api/http";
import { useSession } from "../api/session";

interface Person {
  id: number;
  email: string;
  displayName: string;
  role: string | null;
  active: boolean;
  isService: boolean;
  hasPassword: boolean;
  systems: string[];
  extraScopes: {
    code: string;
    expiresAt: string | null;
    reason: string | null;
    expired: boolean;
  }[];
}

interface Role {
  code: string;
  description: string;
  active: boolean;
}

interface Scope {
  code: string;
  description: string;
  sensitive: boolean;
}

/**
 * The people with an account: who they are, their role, their extra permissions and whether they
 * may enter at all
 *
 * @return  The page
 */
export function UsersPage() {
  const queries = useQueryClient();
  const session = useSession();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const people = useQuery({ queryKey: ["users"], queryFn: () => api<Person[]>("/admin/users") });
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api<Role[]>("/admin/roles") });
  const refresh = () => queries.invalidateQueries({ queryKey: ["users"] });

  const act = async (action: () => Promise<unknown>, done: string) => {
    setMessage(null);
    try {
      await action();
      setMessage({ ok: true, text: done });
      await refresh();
    } catch (failure) {
      setMessage({
        ok: false,
        text: failure instanceof ApiError ? failure.message : "No se pudo completar",
      });
    }
  };

  return (
    <Stack gap={4}>
      <HStack justify="space-between">
        <Text color="fg.muted" fontSize="sm">
          Cada persona entra con su cuenta y usa lo que le dan su rol y sus permisos extra. Una
          cuenta de servicio es la de un sistema: su uso se cuenta aparte.
        </Text>
        <PersonForm roles={roles.data ?? []} onSaved={() => void refresh()} />
      </HStack>
      {message && (
        <Text role="status" fontSize="sm" color={message.ok ? "fg.success" : "fg.error"}>
          {message.text}
        </Text>
      )}
      <Box bg="bg.surface" borderWidth="1px" rounded="panel" overflow="auto">
        {people.isLoading ? (
          <Spinner m={6} color="brand.solid" />
        ) : (
          <Table.Root size="sm">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Persona</Table.ColumnHeader>
                <Table.ColumnHeader>Rol</Table.ColumnHeader>
                <Table.ColumnHeader>Permisos extra</Table.ColumnHeader>
                <Table.ColumnHeader>Entrada</Table.ColumnHeader>
                <Table.ColumnHeader />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {people.data?.map((person) => (
                <Table.Row key={person.id} opacity={person.active ? 1 : 0.6}>
                  <Table.Cell>
                    <HStack gap={2}>
                      <Text fontWeight="medium">{person.displayName}</Text>
                      {!person.active && <Badge size="sm">inactiva</Badge>}
                      {person.isService && (
                        <Badge size="sm" colorPalette="purple" variant="subtle">
                          servicio
                        </Badge>
                      )}
                    </HStack>
                    <Text fontSize="xs" color="fg.subtle">
                      {person.email}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge variant="subtle">{person.role ?? "sin rol"}</Badge>
                  </Table.Cell>
                  <Table.Cell fontSize="xs">
                    {person.extraScopes.length === 0
                      ? "—"
                      : person.extraScopes
                          .filter((extra) => !extra.expired)
                          .map((extra) => extra.code)
                          .join(", ") || "—"}
                  </Table.Cell>
                  <Table.Cell fontSize="xs" color="fg.muted">
                    {[person.hasPassword ? "contraseña" : null, ...person.systems]
                      .filter(Boolean)
                      .join(" · ") || "todavía sin contraseña"}
                  </Table.Cell>
                  <Table.Cell textAlign="end" whiteSpace="nowrap">
                    <PersonForm
                      existing={person}
                      roles={roles.data ?? []}
                      onSaved={() => void refresh()}
                    />
                    <ExtraScopes person={person} onChanged={() => void refresh()} />
                    <IconButton
                      aria-label="Enviar enlace para poner contraseña"
                      size="xs"
                      variant="ghost"
                      disabled={!person.active}
                      onClick={() =>
                        void act(
                          () => api(`/admin/users/${person.id}/password-reset`, { method: "POST" }),
                          `Le llegó a ${person.email} un enlace para poner su contraseña.`,
                        )
                      }
                    >
                      <FiMail />
                    </IconButton>
                    <IconButton
                      aria-label="Borrar"
                      size="xs"
                      variant="ghost"
                      colorPalette="red"
                      disabled={person.id === session?.user.id}
                      onClick={() => {
                        if (
                          window.confirm(
                            `¿Borrar la cuenta de ${person.displayName}? Deja de poder entrar.`,
                          )
                        ) {
                          void act(
                            () => api(`/admin/users/${person.id}`, { method: "DELETE" }),
                            `La cuenta de ${person.displayName} quedó borrada.`,
                          );
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
 * Creates an account, or changes one: name, role, whether it may enter and whether it is a system
 *
 * @param   props  The account being changed, if any, the roles and what to do once saved
 *
 * @return  The button and its dialog
 */
function PersonForm({
  existing,
  roles,
  onSaved,
}: {
  existing?: Person;
  roles: Role[];
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    email: "",
    displayName: "",
    role: "user",
    password: "",
    active: true,
    isService: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = () => {
    setForm({
      email: existing?.email ?? "",
      displayName: existing?.displayName ?? "",
      role:
        existing?.role ?? roles.find((role) => role.code === "user")?.code ?? roles[0]?.code ?? "",
      password: "",
      active: existing?.active ?? true,
      isService: existing?.isService ?? false,
    });
    setError(null);
  };

  const save = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        await api(`/admin/users/${existing.id}`, {
          method: "PATCH",
          body: {
            displayName: form.displayName,
            // Only when it changed: a person whose role was switched off keeps their name editable
            ...(form.role !== existing.role ? { role: form.role } : {}),
            active: form.active,
          },
        });
        if (form.isService !== existing.isService) {
          await api(`/admin/users/${existing.id}/service`, {
            method: "PUT",
            body: { is_service: form.isService },
          });
        }
      } else {
        await api("/admin/users", {
          method: "POST",
          body: {
            email: form.email,
            displayName: form.displayName,
            role: form.role,
            ...(form.password ? { password: form.password } : {}),
          },
        });
      }
      setOpen(false);
      onSaved();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "No se pudo guardar");
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
            <FiPlus /> Nueva cuenta
          </Button>
        )}
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content as="form" onSubmit={save}>
            <Dialog.Header>
              <Dialog.Title>{existing ? existing.displayName : "Nueva cuenta"}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap={3}>
                {!existing && (
                  <Field.Root required>
                    <Field.Label>Correo</Field.Label>
                    <Input
                      type="email"
                      value={form.email}
                      onChange={(event) => setForm({ ...form, email: event.target.value })}
                    />
                  </Field.Root>
                )}
                <Field.Root required>
                  <Field.Label>Nombre</Field.Label>
                  <Input
                    value={form.displayName}
                    onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                  />
                </Field.Root>
                <Field.Root required>
                  <Field.Label>Rol</Field.Label>
                  <NativeSelect.Root>
                    <NativeSelect.Field
                      value={form.role}
                      onChange={(event) => setForm({ ...form, role: event.target.value })}
                    >
                      {roles
                        .filter((role) => role.active)
                        .map((role) => (
                          <option key={role.code} value={role.code}>
                            {role.code} — {role.description}
                          </option>
                        ))}
                    </NativeSelect.Field>
                  </NativeSelect.Root>
                </Field.Root>
                {!existing && (
                  <Field.Root>
                    <Field.Label>Contraseña (opcional)</Field.Label>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      value={form.password}
                      onChange={(event) => setForm({ ...form, password: event.target.value })}
                    />
                    <Field.HelperText>
                      Sin contraseña, mándale después el enlace para que ponga la suya.
                    </Field.HelperText>
                  </Field.Root>
                )}
                {existing && (
                  <>
                    <Toggle
                      label="Puede entrar"
                      checked={form.active}
                      onChange={(active) => setForm({ ...form, active })}
                    />
                    <Toggle
                      label="Es la cuenta de un sistema"
                      checked={form.isService}
                      onChange={(isService) => setForm({ ...form, isService })}
                    />
                  </>
                )}
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
              <Button type="submit" colorPalette="brand" loading={busy}>
                Guardar
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/**
 * A labelled switch
 *
 * @param   props  Label, value and what to do on change
 *
 * @return  The switch
 */
function Toggle({
  label,
  checked,
  onChange,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Switch.Root checked={checked} onCheckedChange={(details) => onChange(details.checked)}>
      <Switch.HiddenInput />
      <Switch.Control />
      <Switch.Label>{label}</Switch.Label>
    </Switch.Root>
  );
}

/**
 * The permissions a person has beyond their role: why, and until when
 *
 * @param   props  The person and what to do after a change
 *
 * @return  The button and its dialog
 */
function ExtraScopes({ person, onChanged }: { person: Person; onChanged: () => void }) {
  const scopes = useQuery({ queryKey: ["scopes"], queryFn: () => api<Scope[]>("/admin/scopes") });
  const [code, setCode] = useState("");
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      onChanged();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "No se pudo completar");
    }
  };

  return (
    <Dialog.Root
      onOpenChange={(details) => {
        if (details.open) {
          setCode("");
          setReason("");
          setUntil("");
          setError(null);
        }
      }}
    >
      <Dialog.Trigger asChild>
        <IconButton aria-label="Permisos extra" size="xs" variant="ghost">
          <FiKey />
        </IconButton>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Permisos extra de {person.displayName}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap={3}>
                {person.extraScopes.length === 0 && (
                  <Text fontSize="sm" color="fg.muted">
                    Solo tiene los de su rol.
                  </Text>
                )}
                {person.extraScopes.map((extra) => (
                  <HStack key={extra.code} justify="space-between" fontSize="sm">
                    <Stack gap={0}>
                      <Text fontFamily="mono">{extra.code}</Text>
                      <Text fontSize="xs" color="fg.muted">
                        {extra.reason}
                        {extra.expired
                          ? ` · venció el ${new Date(extra.expiresAt ?? "").toLocaleDateString()}`
                          : extra.expiresAt
                            ? ` · hasta ${new Date(extra.expiresAt).toLocaleDateString()}`
                            : " · sin vencimiento"}
                      </Text>
                    </Stack>
                    <IconButton
                      aria-label="Quitar"
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        void run(() =>
                          api(`/admin/users/${person.id}/scopes/${extra.code}`, {
                            method: "DELETE",
                          }),
                        )
                      }
                    >
                      <FiX />
                    </IconButton>
                  </HStack>
                ))}
                <Box borderTopWidth="1px" pt={3}>
                  <Stack gap={2}>
                    <NativeSelect.Root size="sm">
                      <NativeSelect.Field
                        value={code}
                        onChange={(event) => setCode(event.target.value)}
                      >
                        <option value="">Permiso…</option>
                        {scopes.data?.map((scope) => (
                          <option key={scope.code} value={scope.code}>
                            {scope.code} — {scope.description}
                          </option>
                        ))}
                      </NativeSelect.Field>
                    </NativeSelect.Root>
                    <Input
                      size="sm"
                      placeholder="Por qué"
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                    />
                    <HStack>
                      <Input
                        size="sm"
                        type="date"
                        value={until}
                        onChange={(event) => setUntil(event.target.value)}
                      />
                      <Button
                        size="sm"
                        colorPalette="brand"
                        disabled={!code || !reason.trim()}
                        onClick={() =>
                          void run(async () => {
                            await api(`/admin/users/${person.id}/scopes/${code}`, {
                              method: "PUT",
                              body: {
                                reason: reason.trim(),
                                // The chosen day lasts until its end
                                expiresAt: until
                                  ? new Date(`${until}T23:59:59`).toISOString()
                                  : null,
                              },
                            });
                            setCode("");
                            setReason("");
                            setUntil("");
                          })
                        }
                      >
                        Dar
                      </Button>
                    </HStack>
                  </Stack>
                </Box>
                {error && (
                  <Text role="alert" fontSize="sm" color="fg.error">
                    {error}
                  </Text>
                )}
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button variant="outline">Cerrar</Button>
              </Dialog.ActionTrigger>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
