import {
  Badge,
  Box,
  Button,
  Checkbox,
  Dialog,
  Field,
  HStack,
  IconButton,
  Input,
  Portal,
  SimpleGrid,
  Spinner,
  Stack,
  Switch,
  Text,
} from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { FiEdit2, FiFolderPlus, FiLock, FiPlus } from "react-icons/fi";
import { ApiError, api } from "../api/http";

interface Role {
  code: string;
  description: string;
  active: boolean;
  protected: boolean;
  scopes: string[];
  people: number;
}

interface Scope {
  code: string;
  description: string;
  sensitive: boolean;
}

/**
 * The roles and what each lets its people do, and the areas of documents
 *
 * @return  The page
 */
export function RolesPage() {
  const queries = useQueryClient();
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api<Role[]>("/admin/roles") });
  const scopes = useQuery({ queryKey: ["scopes"], queryFn: () => api<Scope[]>("/admin/scopes") });
  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ["roles"] });
    void queries.invalidateQueries({ queryKey: ["scopes"] });
  };

  return (
    <Stack gap={4}>
      <HStack justify="space-between">
        <Text color="fg.muted" fontSize="sm">
          Un rol junta los permisos que comparte un grupo de personas. Cada área de documentos es un
          permiso más: quien lo tiene lee los documentos de esa área.
        </Text>
        <HStack>
          <AreaForm onSaved={refresh} />
          <RoleForm scopes={scopes.data ?? []} onSaved={refresh} />
        </HStack>
      </HStack>
      {roles.isLoading ? (
        <Spinner color="brand.solid" />
      ) : (
        <SimpleGrid columns={{ base: 1, lg: 2 }} gap={4}>
          {roles.data?.map((role) => (
            <Box
              key={role.code}
              bg="bg.surface"
              borderWidth="1px"
              rounded="panel"
              p={4}
              opacity={role.active ? 1 : 0.6}
            >
              <HStack justify="space-between" mb={2}>
                <HStack gap={2}>
                  <Text fontFamily="mono" fontWeight="semibold">
                    {role.code}
                  </Text>
                  {role.protected && (
                    <Badge size="sm" variant="subtle">
                      <FiLock /> todos los permisos
                    </Badge>
                  )}
                  {!role.active && <Badge size="sm">inactivo</Badge>}
                </HStack>
                <HStack gap={2}>
                  <Text fontSize="xs" color="fg.muted">
                    {role.people} {role.people === 1 ? "persona" : "personas"}
                  </Text>
                  <RoleForm existing={role} scopes={scopes.data ?? []} onSaved={refresh} />
                </HStack>
              </HStack>
              <Text fontSize="sm" color="fg.muted" mb={2}>
                {role.description}
              </Text>
              <HStack wrap="wrap" gap={1}>
                {role.scopes.map((code) => (
                  <Badge key={code} size="sm" variant="outline" fontFamily="mono">
                    {code}
                  </Badge>
                ))}
              </HStack>
            </Box>
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}

/**
 * Creates a role or changes one; the admin role only takes a new description
 *
 * @param   props  The role being changed, if any, the scopes and what to do once saved
 *
 * @return  The button and its dialog
 */
function RoleForm({
  existing,
  scopes,
  onSaved,
}: {
  existing?: Role;
  scopes: Scope[];
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [active, setActive] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = existing?.protected ?? false;

  const start = () => {
    setCode(existing?.code ?? "");
    setDescription(existing?.description ?? "");
    setActive(existing?.active ?? true);
    setPicked(existing?.scopes ?? ["chat.use"]);
    setError(null);
  };

  const save = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        await api(`/admin/roles/${existing.code}`, {
          method: "PUT",
          body: locked ? { description } : { description, active, scopes: picked },
        });
      } else {
        await api("/admin/roles", { method: "POST", body: { code, description, scopes: picked } });
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
      size="lg"
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
            <FiPlus /> Nuevo rol
          </Button>
        )}
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content as="form" onSubmit={save}>
            <Dialog.Header>
              <Dialog.Title>{existing ? `Rol ${existing.code}` : "Nuevo rol"}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap={3}>
                {!existing && (
                  <Field.Root required>
                    <Field.Label>Código</Field.Label>
                    <Input
                      fontFamily="mono"
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                      placeholder="supervisores"
                    />
                  </Field.Root>
                )}
                <Field.Root required>
                  <Field.Label>Descripción</Field.Label>
                  <Input
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </Field.Root>
                {locked ? (
                  <Text fontSize="sm" color="fg.muted">
                    Este rol tiene siempre todos los permisos, también los que aparezcan después.
                  </Text>
                ) : (
                  <>
                    {existing && (
                      <Switch.Root
                        checked={active}
                        onCheckedChange={(details) => setActive(details.checked)}
                      >
                        <Switch.HiddenInput />
                        <Switch.Control />
                        <Switch.Label>
                          Activo (inactivo, sus personas pierden sus permisos)
                        </Switch.Label>
                      </Switch.Root>
                    )}
                    <Text fontSize="sm" fontWeight="medium">
                      Permisos
                    </Text>
                    <Stack gap={1} maxH="72" overflow="auto">
                      {scopes.map((scope) => (
                        <Checkbox.Root
                          key={scope.code}
                          checked={picked.includes(scope.code)}
                          onCheckedChange={(details) =>
                            setPicked(
                              details.checked
                                ? [...picked, scope.code]
                                : picked.filter((item) => item !== scope.code),
                            )
                          }
                          alignItems="start"
                        >
                          <Checkbox.HiddenInput />
                          <Checkbox.Control mt={0.5} />
                          <Checkbox.Label>
                            <Text as="span" fontFamily="mono" fontSize="sm">
                              {scope.code}
                            </Text>
                            {scope.sensitive && (
                              <Badge ml={2} size="xs" colorPalette="orange" variant="subtle">
                                sensible
                              </Badge>
                            )}
                            <Text fontSize="xs" color="fg.muted">
                              {scope.description}
                            </Text>
                          </Checkbox.Label>
                        </Checkbox.Root>
                      ))}
                    </Stack>
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
 * Opens a new area of documents: a permission that reads the documents loaded under it
 *
 * @param   props  What to do once saved
 *
 * @return  The button and its dialog
 */
function AreaForm({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [area, setArea] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    setError(null);
    try {
      await api("/admin/scopes", { method: "POST", body: { area, description } });
      setOpen(false);
      setArea("");
      setDescription("");
      onSaved();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "No se pudo crear el área");
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(details) => setOpen(details.open)}>
      <Dialog.Trigger asChild>
        <Button variant="outline" size="sm">
          <FiFolderPlus /> Nueva área
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content as="form" onSubmit={save}>
            <Dialog.Header>
              <Dialog.Title>Nueva área de documentos</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap={3}>
                <Field.Root required>
                  <Field.Label>Área</Field.Label>
                  <Input
                    fontFamily="mono"
                    value={area}
                    placeholder="rrhh"
                    onChange={(event) => setArea(event.target.value)}
                  />
                  <Field.HelperText>
                    Es el «area» del encabezado de los documentos.
                  </Field.HelperText>
                </Field.Root>
                <Field.Root required>
                  <Field.Label>Descripción</Field.Label>
                  <Input
                    value={description}
                    placeholder="Leer los documentos de RRHH"
                    onChange={(event) => setDescription(event.target.value)}
                  />
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
              <Button type="submit" colorPalette="brand">
                Crear
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
