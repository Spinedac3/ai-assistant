import { Box, Flex, IconButton, Menu, Portal, Stack, Text } from "@chakra-ui/react";
import { useTheme } from "next-themes";
import type { IconType } from "react-icons";
import { FiFileText, FiLogOut, FiMessageSquare, FiMoon, FiSun, FiUser } from "react-icons/fi";
import { NavLink, Outlet, useMatches } from "react-router";
import { can, setSession, useSession } from "../api/session";

interface NavItem {
  to: string;
  label: string;
  icon: IconType;
  // Shown only to whoever holds it
  scope: string;
}

const NAV: NavItem[] = [
  { to: "/chat", label: "Chat", icon: FiMessageSquare, scope: "chat.use" },
  { to: "/documentos", label: "Documentos", icon: FiFileText, scope: "chat.use" },
];

/**
 * The frame of every page: what the person may use on the left, where they are and who they are
 * on top
 *
 * @return  The layout
 */
export function Layout() {
  const session = useSession();
  const { resolvedTheme, setTheme } = useTheme();
  const matches = useMatches();
  const title = [...matches].reverse().find((match) => (match.handle as { title?: string })?.title)
    ?.handle as { title?: string } | undefined;

  return (
    <Flex h="100dvh" bg="bg.canvas">
      <Stack as="nav" w="220px" flexShrink={0} bg="bg.surface" borderRightWidth="1px" p={3} gap={1}>
        <Text fontFamily="heading" fontWeight="semibold" fontSize="lg" px={3} py={2} mb={2}>
          Asistente
        </Text>
        {NAV.filter((item) => can(session, item.scope)).map((item) => (
          <NavLink key={item.to} to={item.to}>
            {({ isActive }) => (
              <Flex
                align="center"
                gap={3}
                px={3}
                h="control"
                rounded="control"
                fontSize="sm"
                fontWeight={isActive ? "semibold" : "medium"}
                color={isActive ? "brand.fg" : "fg.muted"}
                bg={isActive ? "brand.subtle" : "transparent"}
                _hover={{
                  bg: isActive ? "brand.subtle" : "bg.muted",
                  color: isActive ? "brand.fg" : "fg",
                }}
              >
                <item.icon />
                {item.label}
              </Flex>
            )}
          </NavLink>
        ))}
      </Stack>
      <Flex direction="column" flex={1} minW={0}>
        <Flex
          as="header"
          h="64px"
          flexShrink={0}
          align="center"
          gap={2}
          px={5}
          bg="bg.surface"
          borderBottomWidth="1px"
        >
          <Text fontFamily="heading" fontWeight="semibold" flex={1}>
            {title?.title ?? ""}
          </Text>
          <IconButton
            aria-label={resolvedTheme === "dark" ? "Usar modo claro" : "Usar modo oscuro"}
            variant="ghost"
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          >
            {resolvedTheme === "dark" ? <FiSun /> : <FiMoon />}
          </IconButton>
          <Menu.Root>
            <Menu.Trigger asChild>
              <IconButton aria-label="Mi cuenta" variant="ghost">
                <FiUser />
              </IconButton>
            </Menu.Trigger>
            <Portal>
              <Menu.Positioner>
                <Menu.Content>
                  <Box px={3} py={2}>
                    <Text fontSize="sm" fontWeight="semibold">
                      {session?.user.displayName}
                    </Text>
                    <Text fontSize="xs" color="fg.muted">
                      {session?.user.email}
                    </Text>
                  </Box>
                  <Menu.Separator />
                  <Menu.Item value="salir" onClick={() => setSession(null)}>
                    <FiLogOut />
                    Salir
                  </Menu.Item>
                </Menu.Content>
              </Menu.Positioner>
            </Portal>
          </Menu.Root>
        </Flex>
        <Box as="main" flex={1} minH={0} overflow="auto" p={5}>
          <Outlet />
        </Box>
      </Flex>
    </Flex>
  );
}
