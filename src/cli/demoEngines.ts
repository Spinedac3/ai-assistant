import type { ConnectionInfo, EngineName } from "../sources/engines.js";

export interface DemoEngine {
  // Can write: it builds the demo data
  admin: ConnectionInfo;
  // The read-only user a source is registered with
  reader: ConnectionInfo;
  // First parameter in the engine's own style
  param: string;
}

const local = { host: "localhost", database: "demo", tls: false } as const;

// The demo engines of docker-compose; development passwords, never used anywhere else
export const DEMO_ENGINES: Record<EngineName, DemoEngine> = {
  postgres: {
    admin: { ...local, engine: "postgres", port: 5433, username: "demo", password: "demo" },
    reader: {
      ...local,
      engine: "postgres",
      port: 5433,
      username: "demo_reader",
      password: "demo-reader",
    },
    param: "$1",
  },
  mysql: {
    admin: { ...local, engine: "mysql", port: 3307, username: "root", password: "demo-root" },
    reader: {
      ...local,
      engine: "mysql",
      port: 3307,
      username: "demo_reader",
      password: "demo-reader",
    },
    param: "?",
  },
  mssql: {
    admin: { ...local, engine: "mssql", port: 1434, username: "sa", password: "Demo-Root-2026" },
    reader: {
      ...local,
      engine: "mssql",
      port: 1434,
      username: "demo_reader",
      password: "Demo-Reader-2026",
    },
    param: "@p1",
  },
};
