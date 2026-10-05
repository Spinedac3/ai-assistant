import { Badge, Box, Button, HStack, Spinner, Stack, Table, Text } from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import { FiPlus } from "react-icons/fi";
import { Link, useNavigate } from "react-router";
import { api } from "../api/http";
import type { ToolSummary } from "./types";

/**
 * The tools made in the creator over the sources the person may use, drafts and published
 *
 * @return  The page
 */
export function ToolsPage() {
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ["tools"], queryFn: () => api<ToolSummary[]>("/admin/tools") });

  return (
    <Stack gap={4}>
      <HStack justify="space-between">
        <Text color="fg.muted" fontSize="sm">
          Herramientas que responden preguntas con los datos de una fuente. Nacen como borrador y el
          asistente solo las usa una vez publicadas, con sus chequeos en verde.
        </Text>
        <Button colorPalette="brand" size="sm" onClick={() => navigate("/herramientas/nueva")}>
          <FiPlus /> Nueva herramienta
        </Button>
      </HStack>
      <Box bg="bg.surface" borderWidth="1px" rounded="panel" overflow="auto">
        {list.isLoading ? (
          <Spinner m={6} color="brand.solid" />
        ) : list.data?.length === 0 ? (
          <Text p={6} color="fg.muted">
            Todavía no hay herramientas sobre tus fuentes. Crea la primera con «Nueva herramienta».
          </Text>
        ) : (
          <Table.Root size="sm" interactive>
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Herramienta</Table.ColumnHeader>
                <Table.ColumnHeader>Fuente</Table.ColumnHeader>
                <Table.ColumnHeader>Estado</Table.ColumnHeader>
                <Table.ColumnHeader>Cambiada</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {list.data?.map((tool) => (
                <Table.Row key={tool.name}>
                  <Table.Cell>
                    <Link to={`/herramientas/${tool.name}`}>
                      <Text fontFamily="mono" fontSize="sm" color="brand.fg" fontWeight="medium">
                        {tool.name}
                      </Text>
                    </Link>
                  </Table.Cell>
                  <Table.Cell fontFamily="mono" fontSize="xs">
                    {tool.source}
                  </Table.Cell>
                  <Table.Cell>
                    <Badge
                      variant="subtle"
                      colorPalette={tool.status === "published" ? "green" : "gray"}
                    >
                      {tool.status === "published" ? "Publicada" : "Borrador"}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell fontSize="xs" color="fg.muted">
                    {new Date(tool.updated_at).toLocaleString()}
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
