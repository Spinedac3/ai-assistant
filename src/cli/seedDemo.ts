import mssql from "mssql";
import mysql from "mysql2/promise";
import pg from "pg";

// Builds the invented distributor on each demo engine, with the same rows everywhere, and a
// read-only user for it. Usage: pnpm demo:seed [postgres] [mysql] [mssql]

type Engine = "postgres" | "mysql" | "mssql";
type Row = Array<string | number | boolean | null>;

interface Table {
  name: string;
  columns: Array<{ name: string; type: Record<Engine, string> }>;
  rows: Row[];
}

const INT = { postgres: "integer", mysql: "int", mssql: "int" };
const TEXT = (size: number) => ({
  postgres: `varchar(${size})`,
  mysql: `varchar(${size})`,
  mssql: `nvarchar(${size})`,
});
const MONEY = { postgres: "numeric(12,2)", mysql: "decimal(12,2)", mssql: "decimal(12,2)" };
const BOOL = { postgres: "boolean", mysql: "boolean", mssql: "bit" };
const DATE = { postgres: "date", mysql: "date", mssql: "date" };
const STAMP = { postgres: "timestamp", mysql: "datetime", mssql: "datetime2(0)" };

/**
 * Deterministic pseudo random numbers, so every engine and every run gets the same data
 *
 * @param   seed  Starting point
 *
 * @return  A function returning numbers in [0, 1)
 */
function random(seed: number): () => number {
  let state = seed;

  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Builds the tables of the distributor with their rows
 *
 * @return  The tables, parents first
 */
function distributor(): Table[] {
  const next = random(2026);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const zones = ["Norte", "Sur", "Oriente", "Occidente", "Centro"];
  const names = [
    "Abarrotería",
    "Tienda",
    "Supermercado",
    "Minimarket",
    "Comercial",
    "Distribuidora",
  ];
  const owners = ["La Esperanza", "San José", "El Carmen", "Los Pinos", "Don Pepe", "La Bendición"];
  const pad = (value: number) => String(value).padStart(2, "0");

  const clients: Row[] = Array.from({ length: 40 }, (_, index) => {
    const kind = index < 6 ? "mayorista" : index < 9 ? "institucional" : "detallista";
    const limit = kind === "mayorista" ? 50_000 : kind === "institucional" ? 80_000 : 10_000;
    return [
      index + 1,
      `${pick(names)} ${pick(owners)} ${index + 1}`,
      kind,
      zones[index % zones.length] as string,
      limit,
      `2025-${pad(1 + (index % 12))}-${pad(1 + (index % 28))}`,
    ];
  });

  const catalog = [
    ["Leche entera 1 L", "Lácteos", 12.5, true],
    ["Yogur natural 1 L", "Lácteos", 18.75, true],
    ["Queso fresco 500 g", "Lácteos", 32, true],
    ["Arroz 1 kg", "Granos", 11.9, false],
    ["Frijol negro 1 kg", "Granos", 14.5, false],
    ["Azúcar 2 kg", "Básicos", 19.8, false],
    ["Aceite 900 ml", "Básicos", 24.9, false],
    ["Harina 1 kg", "Básicos", 9.75, false],
    ["Café molido 400 g", "Bebidas", 38.5, false],
    ["Agua pura 600 ml", "Bebidas", 4.25, false],
    ["Jugo de naranja 1 L", "Bebidas", 15.6, true],
    ["Gaseosa 3 L", "Bebidas", 21, false],
    ["Detergente 1 kg", "Limpieza", 27.3, false],
    ["Cloro 1 L", "Limpieza", 8.9, false],
    ["Jabón de baño 3 u", "Limpieza", 16.4, false],
    ["Papel higiénico 12 u", "Limpieza", 42, false],
    ["Pollo entero kg", "Carnes", 22.5, true],
    ["Salchicha 1 lb", "Carnes", 17.9, true],
    ["Huevos 30 u", "Básicos", 36, false],
    ["Pasta 400 g", "Granos", 7.8, false],
  ] as const;
  const products: Row[] = catalog.map(([name, category, price, cold], index) => [
    index + 1,
    `SKU-${String(index + 1).padStart(4, "0")}`,
    name,
    category,
    price,
    cold,
  ]);

  const orders: Row[] = [];
  const lines: Row[] = [];
  const deliveries: Row[] = [];
  for (let order = 1; order <= 500; order++) {
    const month = 1 + Math.floor(next() * 9);
    const day = 1 + Math.floor(next() * 28);
    const hour = 7 + Math.floor(next() * 10);
    const client = 1 + Math.floor(next() * clients.length);
    const state = next() < 0.08 ? "cancelado" : month === 9 && day > 20 ? "pendiente" : "entregado";
    let total = 0;

    const count = 1 + Math.floor(next() * 5);
    for (let item = 0; item < count; item++) {
      const product = 1 + Math.floor(next() * products.length);
      const quantity = 1 + Math.floor(next() * 24);
      const price = Number(products[product - 1]?.[4]);
      total += quantity * price;
      lines.push([lines.length + 1, order, product, quantity, price]);
    }

    orders.push([
      order,
      client,
      `2026-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(Math.floor(next() * 60))}:00`,
      state,
      Math.round(total * 100) / 100,
    ]);

    if (state === "entregado") {
      const zone = String(clients[client - 1]?.[3]);
      const late = next() < 0.07;
      deliveries.push([
        deliveries.length + 1,
        order,
        `R-${zone}-${1 + Math.floor(next() * 2)}`,
        pick(["Carlos Méndez", "Luis Ajú", "Mario Chen", "Ana Gómez", "Pedro Xol"]),
        `2026-${pad(month)}-${pad(Math.min(day + 1, 28))} ${pad(late ? 18 : 10)}:00:00`,
        !late,
      ]);
    }
  }

  return [
    {
      name: "clientes",
      columns: [
        { name: "id", type: INT },
        { name: "nombre", type: TEXT(120) },
        { name: "tipo", type: TEXT(20) },
        { name: "zona", type: TEXT(20) },
        { name: "limite_credito", type: MONEY },
        { name: "creado_en", type: DATE },
      ],
      rows: clients,
    },
    {
      name: "productos",
      columns: [
        { name: "id", type: INT },
        { name: "sku", type: TEXT(20) },
        { name: "nombre", type: TEXT(120) },
        { name: "categoria", type: TEXT(40) },
        { name: "precio", type: MONEY },
        { name: "refrigerado", type: BOOL },
      ],
      rows: products,
    },
    {
      name: "pedidos",
      columns: [
        { name: "id", type: INT },
        { name: "cliente_id", type: INT },
        { name: "fecha", type: STAMP },
        { name: "estado", type: TEXT(20) },
        { name: "total", type: MONEY },
      ],
      rows: orders,
    },
    {
      name: "pedido_detalle",
      columns: [
        { name: "id", type: INT },
        { name: "pedido_id", type: INT },
        { name: "producto_id", type: INT },
        { name: "cantidad", type: INT },
        { name: "precio_unitario", type: MONEY },
      ],
      rows: lines,
    },
    {
      name: "entregas",
      columns: [
        { name: "id", type: INT },
        { name: "pedido_id", type: INT },
        { name: "ruta", type: TEXT(30) },
        { name: "piloto", type: TEXT(80) },
        { name: "entregado_en", type: STAMP },
        { name: "a_tiempo", type: BOOL },
      ],
      rows: deliveries,
    },
  ];
}

interface Admin {
  run: (sql: string, params?: Row) => Promise<void>;
  placeholder: (position: number) => string;
  close: () => Promise<void>;
}

/**
 * Connects to an engine as its administrator
 *
 * @param   engine  Engine
 *
 * @return  A way to run statements, or null when the engine is not running
 */
async function connect(engine: Engine): Promise<Admin | null> {
  try {
    if (engine === "postgres") {
      const client = new pg.Client({
        host: "localhost",
        port: 5433,
        user: "demo",
        password: "demo",
        database: "demo",
      });
      await client.connect();
      return {
        run: async (sql, params = []) => {
          await client.query(sql, params);
        },
        placeholder: (position) => `$${position}`,
        close: () => client.end(),
      };
    }

    if (engine === "mysql") {
      const connection = await mysql.createConnection({
        host: "localhost",
        port: 3307,
        user: "root",
        password: "demo-root",
        database: "demo",
      });
      return {
        run: async (sql, params = []) => {
          await connection.query(sql, params);
        },
        placeholder: () => "?",
        close: () => connection.end(),
      };
    }

    const pool = await new mssql.ConnectionPool({
      server: "localhost",
      port: 1434,
      user: "sa",
      password: "Demo-Root-2026",
      database: "master",
      options: { encrypt: false, trustServerCertificate: true },
    }).connect();
    await pool.request().query("if db_id('demo') is null create database demo");
    await pool.close();
    const demo = await new mssql.ConnectionPool({
      server: "localhost",
      port: 1434,
      user: "sa",
      password: "Demo-Root-2026",
      database: "demo",
      options: { encrypt: false, trustServerCertificate: true },
    }).connect();
    return {
      run: async (sql, params = []) => {
        const request = demo.request();
        for (const [position, value] of params.entries()) {
          request.input(`p${position + 1}`, value);
        }
        await request.query(sql);
      },
      placeholder: (position) => `@p${position}`,
      close: () => demo.close(),
    };
  } catch (error) {
    console.warn(`${engine}: no disponible (${(error as Error).message}); se omite`);
    return null;
  }
}

// The read-only user every demo engine gets, the one a source is registered with
const READER: Record<Engine, string[]> = {
  postgres: [
    "do $$ begin if not exists (select from pg_roles where rolname = 'demo_reader') then create role demo_reader login password 'demo-reader'; end if; end $$",
    "grant connect on database demo to demo_reader",
    "grant usage on schema public to demo_reader",
    "grant select on all tables in schema public to demo_reader",
  ],
  mysql: [
    "create user if not exists 'demo_reader'@'%' identified by 'demo-reader'",
    "grant select on demo.* to 'demo_reader'@'%'",
  ],
  mssql: [
    "if not exists (select 1 from sys.server_principals where name = 'demo_reader') create login demo_reader with password = 'Demo-Reader-2026'",
    "if not exists (select 1 from sys.database_principals where name = 'demo_reader') create user demo_reader for login demo_reader",
    "alter role db_datareader add member demo_reader",
  ],
};

/**
 * Recreates the distributor on one engine
 *
 * @param   engine  Engine
 * @param   admin   Administrator connection
 */
async function seed(engine: Engine, admin: Admin): Promise<void> {
  const tables = distributor();

  for (const table of [...tables].reverse()) {
    await admin.run(`drop table if exists ${table.name}`);
  }

  for (const table of tables) {
    const columns = table.columns.map((column) => `${column.name} ${column.type[engine]}`);
    await admin.run(`create table ${table.name} (${columns.join(", ")}, primary key (id))`);

    // Batches stay under SQL Server's limit of 2100 parameters per statement
    for (let start = 0; start < table.rows.length; start += 200) {
      const batch = table.rows.slice(start, start + 200);
      let position = 0;
      const values = batch.map(
        (row) => `(${row.map(() => admin.placeholder(++position)).join(", ")})`,
      );
      await admin.run(
        `insert into ${table.name} (${table.columns.map((c) => c.name).join(", ")}) values ${values.join(", ")}`,
        batch.flat(),
      );
    }
  }

  for (const statement of READER[engine]) {
    await admin.run(statement);
  }

  console.info(
    `${engine}: ${tables.map((table) => `${table.name} ${table.rows.length}`).join(", ")}`,
  );
}

const wanted = (process.argv.slice(2) as Engine[]).filter((engine) =>
  ["postgres", "mysql", "mssql"].includes(engine),
);
for (const engine of wanted.length > 0 ? wanted : (["postgres", "mysql", "mssql"] as Engine[])) {
  const admin = await connect(engine);
  if (admin) {
    try {
      await seed(engine, admin);
    } finally {
      await admin.close();
    }
  }
}
