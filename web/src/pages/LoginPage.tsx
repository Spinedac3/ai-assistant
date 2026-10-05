import { Box, Button, Field, Heading, Input, Stack, Text } from "@chakra-ui/react";
import { useState } from "react";
import { ApiError, api } from "../api/http";
import { type SessionUser, setSession } from "../api/session";

/**
 * The entrance: email and password, and the server's own words when it says no
 *
 * @return  The page
 */
export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ token: string; user: SessionUser }>("/auth/login", {
        method: "POST",
        body: { email, password },
      });
      setSession({ token: data.token, user: data.user });
    } catch (failure) {
      setError(
        failure instanceof ApiError ? failure.message : "No se pudo entrar; vuelve a intentarlo",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box minH="100dvh" display="grid" placeItems="center" bg="bg.canvas" px={4}>
      <Box
        as="form"
        onSubmit={submit}
        w="full"
        maxW="sm"
        bg="bg.surface"
        borderWidth="1px"
        borderColor="border"
        rounded="panel"
        shadow="sm"
        p={8}
      >
        <Stack gap={5}>
          <Stack gap={1}>
            <Text fontFamily="mono" fontSize="xs" color="fg.subtle">
              {"// Asistente"}
            </Text>
            <Heading size="lg">Entrar</Heading>
          </Stack>
          <Field.Root required>
            <Field.Label>Correo</Field.Label>
            <Input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              bg="bg.field"
            />
          </Field.Root>
          <Field.Root required>
            <Field.Label>Contraseña</Field.Label>
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              bg="bg.field"
            />
          </Field.Root>
          {error && (
            <Text role="alert" color="fg.error" fontSize="sm">
              {error}
            </Text>
          )}
          <Button type="submit" colorPalette="brand" loading={busy}>
            Entrar
          </Button>
        </Stack>
      </Box>
    </Box>
  );
}
