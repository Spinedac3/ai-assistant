import {
  Badge,
  Box,
  HStack,
  NativeSelect,
  SimpleGrid,
  Spinner,
  Stack,
  Table,
  Text,
} from "@chakra-ui/react";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { api } from "../api/http";

interface Totals {
  activePeople: number;
  questions: number;
  mcpCalls: number;
  costUsd: number;
  tokens: number;
}

interface Report {
  totals: Totals;
  previous: Totals;
  byChannel: Record<"chat" | "mcp" | "runs" | "trials" | "apps", number>;
  byPerson: {
    userId: number;
    name: string;
    role: string | null;
    questions: number;
    mcpCalls: number;
    trials: number;
    runs: number;
    costUsd: number;
    lastActivity: string | null;
  }[];
  services: { userId: number; name: string; events: number; costUsd: number }[];
  byTool: {
    tool: string | null;
    calls: number;
    errors: number;
    avgMs: number;
    truncated: number;
  }[];
  byDay: { day: string; questions: number; mcpCalls: number }[];
  inactive: { userId: number; name: string; role: string | null }[];
  ratings: { count: number; averageStars: number | null };
}

const CHANNELS = {
  chat: "Chat",
  mcp: "Clientes externos",
  runs: "Corridas de agentes",
  trials: "Pruebas del creador",
  apps: "Sistemas",
} as const;

const money = (value: number) => `US$ ${value.toFixed(2)}`;

/**
 * How much the assistant is used: in numbers only, never what anyone asked
 *
 * @return  The page
 */
export function UsagePage() {
  const [days, setDays] = useState(30);
  const report = useQuery({
    queryKey: ["usage", days],
    queryFn: () => api<Report>(`/admin/usage?days=${days}`),
  });
  const data = report.data;
  const peak = Math.max(1, ...(data?.byDay ?? []).map((day) => day.questions + day.mcpCalls));

  return (
    <Stack gap={4}>
      <HStack justify="space-between">
        <Text color="fg.muted" fontSize="sm">
          Solo conteos: el reporte nunca muestra lo que alguien preguntó.
        </Text>
        <NativeSelect.Root size="sm" width="auto">
          <NativeSelect.Field
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            {[7, 30, 90, 365].map((value) => (
              <option key={value} value={value}>
                Últimos {value} días
              </option>
            ))}
          </NativeSelect.Field>
        </NativeSelect.Root>
      </HStack>
      {!data ? (
        <Spinner color="brand.solid" />
      ) : (
        <>
          <SimpleGrid columns={{ base: 2, md: 4 }} gap={3}>
            <Figure
              label="Personas activas"
              now={data.totals.activePeople}
              before={data.previous.activePeople}
            />
            <Figure
              label="Preguntas en el chat"
              now={data.totals.questions}
              before={data.previous.questions}
            />
            <Figure
              label="Llamadas externas"
              now={data.totals.mcpCalls}
              before={data.previous.mcpCalls}
            />
            <Figure
              label="Costo"
              now={data.totals.costUsd}
              before={data.previous.costUsd}
              format={money}
            />
          </SimpleGrid>

          <Panel title="Por canal">
            <HStack wrap="wrap" gap={6}>
              {Object.entries(CHANNELS).map(([key, label]) => (
                <Stack key={key} gap={0}>
                  <Text fontSize="xs" color="fg.muted">
                    {label}
                  </Text>
                  <Text fontSize="lg" fontWeight="semibold" fontVariantNumeric="tabular-nums">
                    {data.byChannel[key as keyof typeof CHANNELS]}
                  </Text>
                </Stack>
              ))}
              <Stack gap={0}>
                <Text fontSize="xs" color="fg.muted">
                  Calificaciones
                </Text>
                <Text fontSize="lg" fontWeight="semibold">
                  {data.ratings.count}
                  {data.ratings.averageStars !== null &&
                    ` · ${data.ratings.averageStars.toFixed(1)} ★`}
                </Text>
              </Stack>
            </HStack>
          </Panel>

          <Panel title="Por día">
            <Stack gap={1}>
              {data.byDay.map((day) => (
                <HStack key={day.day} gap={3} fontSize="xs">
                  <Text w="20" fontFamily="mono" color="fg.muted">
                    {day.day}
                  </Text>
                  <Box flex={1}>
                    <Box
                      h="2"
                      rounded="full"
                      bg="brand.solid"
                      w={`${((day.questions + day.mcpCalls) / peak) * 100}%`}
                      minW="1"
                    />
                  </Box>
                  <Text w="16" textAlign="end" fontVariantNumeric="tabular-nums">
                    {day.questions + day.mcpCalls}
                  </Text>
                </HStack>
              ))}
            </Stack>
          </Panel>

          <Panel title="Por persona">
            <Table.Root size="sm">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Persona</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">Preguntas</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">Externas</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">Pruebas</Table.ColumnHeader>
                  <Table.ColumnHeader textAlign="end">Costo</Table.ColumnHeader>
                  <Table.ColumnHeader>Última vez</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.byPerson.map((person) => (
                  <Table.Row key={person.userId}>
                    <Table.Cell>
                      {person.name} <Badge size="xs">{person.role ?? "sin rol"}</Badge>
                    </Table.Cell>
                    <Table.Cell textAlign="end">{person.questions}</Table.Cell>
                    <Table.Cell textAlign="end">{person.mcpCalls}</Table.Cell>
                    <Table.Cell textAlign="end">{person.trials}</Table.Cell>
                    <Table.Cell textAlign="end">{money(person.costUsd)}</Table.Cell>
                    <Table.Cell fontSize="xs" color="fg.muted">
                      {person.lastActivity ? new Date(person.lastActivity).toLocaleString() : "—"}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Panel>

          <SimpleGrid columns={{ base: 1, lg: 2 }} gap={4}>
            <Panel title="Por herramienta">
              <Stack gap={1} fontSize="sm">
                {data.byTool.map((tool) => (
                  <HStack key={tool.tool ?? "_otras"} justify="space-between">
                    <Text
                      fontFamily={tool.tool ? "mono" : undefined}
                      color={tool.tool ? undefined : "fg.muted"}
                    >
                      {tool.tool ?? "Otras, de pocas personas"}
                    </Text>
                    <Text fontVariantNumeric="tabular-nums">
                      {tool.calls}
                      {tool.errors > 0 && (
                        <Text as="span" color="fg.error">
                          {" "}
                          · {tool.errors} con error
                        </Text>
                      )}
                    </Text>
                  </HStack>
                ))}
              </Stack>
            </Panel>
            <Panel title="Sistemas y sin uso">
              <Stack gap={1} fontSize="sm">
                {data.services.map((service) => (
                  <HStack key={service.userId} justify="space-between">
                    <Text>{service.name}</Text>
                    <Text color="fg.muted">
                      {service.events} · {money(service.costUsd)}
                    </Text>
                  </HStack>
                ))}
                <Text fontSize="xs" color="fg.muted" mt={2}>
                  {data.inactive.length} personas con acceso no lo usaron en el período
                  {data.inactive.length > 0 &&
                    `: ${data.inactive.map((person) => person.name).join(", ")}`}
                </Text>
              </Stack>
            </Panel>
          </SimpleGrid>
        </>
      )}
    </Stack>
  );
}

/**
 * A figure of the period beside the one before
 *
 * @param   props  Label, both values and how to write them
 *
 * @return  The figure
 */
function Figure({
  label,
  now,
  before,
  format = String,
}: {
  label: string;
  now: number;
  before: number;
  format?: (value: number) => string;
}) {
  return (
    <Box bg="bg.surface" borderWidth="1px" rounded="panel" p={4}>
      <Text fontSize="xs" color="fg.muted">
        {label}
      </Text>
      <Text
        fontSize="2xl"
        fontWeight="semibold"
        fontFamily="heading"
        fontVariantNumeric="tabular-nums"
      >
        {format(now)}
      </Text>
      <Text fontSize="xs" color="fg.subtle">
        antes: {format(before)}
      </Text>
    </Box>
  );
}

/**
 * A titled block of the report
 *
 * @param   props  Title and content
 *
 * @return  The block
 */
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box bg="bg.surface" borderWidth="1px" rounded="panel" p={4}>
      <Text fontWeight="semibold" mb={3}>
        {title}
      </Text>
      {children}
    </Box>
  );
}
