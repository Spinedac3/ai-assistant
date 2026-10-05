import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";

export type Channel = "chat" | "mcp" | "runs" | "trials" | "apps";

export const CHANNELS: readonly Channel[] = ["chat", "mcp", "runs", "trials", "apps"];

export interface PeriodTotals {
  activePeople: number;
  questions: number;
  mcpCalls: number;
  costUsd: number;
  tokens: number;
}

export interface UsageReport {
  period: { from: string; to: string; days: number };
  totals: PeriodTotals;
  previous: PeriodTotals;
  byChannel: Record<Channel, number>;
  byPerson: {
    userId: number;
    name: string;
    email: string;
    role: string | null;
    questions: number;
    mcpCalls: number;
    toolCalls: number;
    costUsd: number;
    tokens: number;
    lastActivity: string;
  }[];
  byRole: { role: string | null; activePeople: number; questions: number; mcpCalls: number }[];
  byTool: { tool: string; calls: number; errors: number; avgMs: number; truncated: number }[];
  byDay: { day: string; questions: number; mcpCalls: number }[];
  inactive: { userId: number; name: string; email: string; role: string | null }[];
  ratings: { count: number; averageStars: number | null };
}

/**
 * Every activity of the window as one row each: a question asked or a tool called, with the
 * channel it came through. Service accounts go to apps whatever the path, and a tool called while
 * answering a question is not a second activity
 *
 * @param   from  Start of the window
 * @param   to    End of the window
 *
 * @return  The query of the events
 */
function eventsBetween(from: Date, to: Date) {
  return sql`
    select c.user_id, m.created_at,
      case when u.is_service then 'apps' when c.tool_name is not null then 'trials' else 'chat' end as channel
    from messages m
    join conversations c on c.id = m.conversation_id
    join users u on u.id = c.user_id
    where m.role = 'user' and m.created_at >= ${from} and m.created_at < ${to}
    union all
    select t.user_id, t.created_at,
      case when u.is_service then 'apps' when t.origin = 'mcp' then 'mcp' else 'runs' end as channel
    from tool_calls t
    join users u on u.id = t.user_id
    where t.origin in ('mcp', 'run') and t.created_at >= ${from} and t.created_at < ${to}`;
}

/**
 * What the answers of a window cost and how many tokens they took, per person; systems apart
 *
 * @param   from  Start of the window
 * @param   to    End of the window
 *
 * @return  The query of the spend
 */
function spendBetween(from: Date, to: Date) {
  return sql`
    select c.user_id,
      coalesce(sum(m.cost_usd_millionths), 0)::bigint as cost,
      coalesce(sum(coalesce(m.tokens_in, 0) + coalesce(m.tokens_out, 0)), 0)::bigint as tokens
    from messages m
    join conversations c on c.id = m.conversation_id
    join users u on u.id = c.user_id and not u.is_service
    where m.role = 'assistant' and m.created_at >= ${from} and m.created_at < ${to}
    group by c.user_id`;
}

/**
 * Adds up the people, questions, calls and spend of a window, people only
 *
 * @param   db    Own database
 * @param   from  Start of the window
 * @param   to    End of the window
 *
 * @return  The totals
 */
async function totalsBetween(db: Database, from: Date, to: Date): Promise<PeriodTotals> {
  const result = await db.execute(sql`
    with events as (${eventsBetween(from, to)}), spend as (${spendBetween(from, to)})
    select
      (select count(distinct user_id) from events where channel in ('chat', 'mcp'))::int as people,
      (select count(*) from events where channel = 'chat')::int as questions,
      (select count(*) from events where channel = 'mcp')::int as mcp,
      (select coalesce(sum(cost), 0) from spend)::bigint as cost,
      (select coalesce(sum(tokens), 0) from spend)::bigint as tokens`);
  const row = result.rows[0] as Record<string, unknown>;

  return {
    activePeople: Number(row.people),
    questions: Number(row.questions),
    mcpCalls: Number(row.mcp),
    costUsd: Number(row.cost) / 1_000_000,
    tokens: Number(row.tokens),
  };
}

/**
 * Builds the usage report of the last days: only counts, never what anyone asked
 *
 * @param   db        Own database
 * @param   days      Length of the window
 * @param   timeZone  Zone where days are cut
 * @param   now       End of the window
 *
 * @return  The report
 */
export async function usageReport(
  db: Database,
  days: number,
  timeZone: string,
  now: Date = new Date(),
): Promise<UsageReport> {
  const from = new Date(now.getTime() - days * 86_400_000);
  const before = new Date(from.getTime() - days * 86_400_000);
  const events = eventsBetween(from, now);
  const spend = spendBetween(from, now);
  // The role of each person, when it is still active
  const people = sql`
    select u.id, u.display_name, u.email, r.code as role
    from users u
    left join roles r on r.id = u.primary_role_id and r.active
    where not u.is_service`;

  const channels = await db.execute(sql`
    with events as (${events})
    select channel, count(*)::int as total from events group by channel`);
  const byChannel = Object.fromEntries(CHANNELS.map((channel) => [channel, 0])) as Record<
    Channel,
    number
  >;
  for (const row of channels.rows as { channel: Channel; total: number }[]) {
    byChannel[row.channel] = row.total;
  }

  const persons = await db.execute(sql`
    with events as (${events}), spend as (${spend}),
    tools as (
      select user_id, count(*)::int as calls from tool_calls
      where created_at >= ${from} and created_at < ${now} group by user_id
    ),
    people as (${people})
    select p.id, p.display_name, p.email, p.role,
      count(*) filter (where e.channel = 'chat')::int as questions,
      count(*) filter (where e.channel = 'mcp')::int as mcp,
      coalesce(max(t.calls), 0)::int as tools,
      coalesce(max(s.cost), 0)::bigint as cost,
      coalesce(max(s.tokens), 0)::bigint as tokens,
      max(e.created_at) as last
    from people p
    join events e on e.user_id = p.id and e.channel in ('chat', 'mcp')
    left join tools t on t.user_id = p.id
    left join spend s on s.user_id = p.id
    group by p.id, p.display_name, p.email, p.role
    order by count(*) desc, p.id`);

  const roles = await db.execute(sql`
    with events as (${events}), people as (${people})
    select p.role,
      count(distinct p.id)::int as people,
      count(*) filter (where e.channel = 'chat')::int as questions,
      count(*) filter (where e.channel = 'mcp')::int as mcp
    from people p
    join events e on e.user_id = p.id and e.channel in ('chat', 'mcp')
    group by p.role
    order by people desc, p.role`);

  const tools = await db.execute(sql`
    select tool_name, count(*)::int as calls,
      count(*) filter (where not success)::int as errors,
      round(avg(duration_ms))::int as avg_ms,
      count(*) filter (where truncated)::int as truncated
    from tool_calls
    where created_at >= ${from} and created_at < ${now}
    group by tool_name
    order by calls desc, tool_name`);

  const daily = await db.execute(sql`
    with events as (${events})
    select to_char(created_at at time zone ${timeZone}, 'YYYY-MM-DD') as day,
      count(*) filter (where channel = 'chat')::int as questions,
      count(*) filter (where channel = 'mcp')::int as mcp
    from events
    group by day
    order by day`);

  // People who may chat, by their role or an extra scope still in force, and did nothing
  const inactive = await db.execute(sql`
    with events as (${events}), people as (${people}),
    allowed as (
      select u.id from users u
      join roles r on r.id = u.primary_role_id and r.active
      join role_scopes rs on rs.role_id = r.id
      join scopes s on s.id = rs.scope_id and s.code = 'chat.use' and s.deleted_at is null
      union
      select ue.user_id from user_extra_scopes ue
      join scopes s on s.id = ue.scope_id and s.code = 'chat.use' and s.deleted_at is null
      where ue.expires_at is null or ue.expires_at > now()
    )
    select p.id, p.display_name, p.email, p.role
    from people p
    join users u on u.id = p.id and u.active and u.deleted_at is null
    where p.id in (select id from allowed)
      and not exists (select 1 from events e where e.user_id = p.id and e.channel in ('chat', 'mcp'))
    order by p.display_name, p.id`);

  const ratings = await db.execute(sql`
    select count(*)::int as total, avg(stars)::float as average
    from message_ratings
    where created_at >= ${from} and created_at < ${now}`);
  const rated = ratings.rows[0] as { total: number; average: number | null };

  return {
    period: { from: from.toISOString(), to: now.toISOString(), days },
    totals: await totalsBetween(db, from, now),
    previous: await totalsBetween(db, before, from),
    byChannel,
    byPerson: (persons.rows as Record<string, unknown>[]).map((row) => ({
      userId: Number(row.id),
      name: String(row.display_name),
      email: String(row.email),
      role: (row.role as string | null) ?? null,
      questions: Number(row.questions),
      mcpCalls: Number(row.mcp),
      toolCalls: Number(row.tools),
      costUsd: Number(row.cost) / 1_000_000,
      tokens: Number(row.tokens),
      lastActivity: new Date(row.last as string).toISOString(),
    })),
    byRole: (roles.rows as Record<string, unknown>[]).map((row) => ({
      role: (row.role as string | null) ?? null,
      activePeople: Number(row.people),
      questions: Number(row.questions),
      mcpCalls: Number(row.mcp),
    })),
    byTool: (tools.rows as Record<string, unknown>[]).map((row) => ({
      tool: String(row.tool_name),
      calls: Number(row.calls),
      errors: Number(row.errors),
      avgMs: Number(row.avg_ms),
      truncated: Number(row.truncated),
    })),
    byDay: (daily.rows as Record<string, unknown>[]).map((row) => ({
      day: String(row.day),
      questions: Number(row.questions),
      mcpCalls: Number(row.mcp),
    })),
    inactive: (inactive.rows as Record<string, unknown>[]).map((row) => ({
      userId: Number(row.id),
      name: String(row.display_name),
      email: String(row.email),
      role: (row.role as string | null) ?? null,
    })),
    ratings: { count: rated.total, averageStars: rated.average },
  };
}
