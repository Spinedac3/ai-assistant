import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";

export type Channel = "chat" | "mcp" | "runs" | "trials" | "apps";

export const CHANNELS: readonly Channel[] = ["chat", "mcp", "runs", "trials", "apps"];

// A tool used by fewer people than this in the window is shown only in a shared row: with one or
// two users its name alone would tell what a given person asked about. Systems are not people
// and do not count toward it
export const MIN_PEOPLE_PER_TOOL = 3;

export interface PeriodTotals {
  // People with any activity of their own: chat, external client, runs or trials
  activePeople: number;
  questions: number;
  mcpCalls: number;
  // Of people; what systems spend is under services
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
    trials: number;
    runs: number;
    // Every call made for this person, whatever the path
    toolCalls: number;
    costUsd: number;
    tokens: number;
    lastActivity: string | null;
  }[];
  // Every account marked as a system, and a deleted one that still did something in the window,
  // so the mark never hides anything
  services: {
    userId: number;
    name: string;
    email: string;
    events: number;
    costUsd: number;
    tokens: number;
  }[];
  byRole: { role: string | null; activePeople: number; questions: number; mcpCalls: number }[];
  // tool is null in the row that gathers the tools used by too few people
  byTool: {
    tool: string | null;
    calls: number;
    errors: number;
    avgMs: number;
    truncated: number;
  }[];
  byDay: { day: string; questions: number; mcpCalls: number }[];
  inactive: { userId: number; name: string; email: string; role: string | null }[];
  ratings: { count: number; averageStars: number | null };
}

/**
 * Every activity of the window as one row each: a question asked or a tool called, with the
 * channel it came through. Service accounts go to apps whatever the path, and a tool called while
 * answering a question is not a second activity. Deleted conversations count: deleting one does
 * not undo its use
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
 * What the answers of a window cost and how many tokens they took, per account; cut by the time of
 * the answer, which is when the cost happened
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
async function totalsBetween(
  db: Pick<Database, "execute">,
  from: Date,
  to: Date,
): Promise<PeriodTotals> {
  const result = await db.execute(sql`
    with events as (${eventsBetween(from, to)}), spend as (${spendBetween(from, to)})
    select
      (select count(distinct user_id) from events where channel <> 'apps')::int as people,
      (select count(*) from events where channel = 'chat')::int as questions,
      (select count(*) from events where channel = 'mcp')::int as mcp,
      (select coalesce(sum(s.cost), 0) from spend s join users u on u.id = s.user_id and not u.is_service)::bigint as cost,
      (select coalesce(sum(s.tokens), 0) from spend s join users u on u.id = s.user_id and not u.is_service)::bigint as tokens`);
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
 * The window is the last days counted back from now, so its first and last calendar days are
 * partial
 *
 * @param   database  Own database
 * @param   days      Length of the window
 * @param   timeZone  Zone where days are cut
 * @param   now       End of the window
 *
 * @return  The report
 */
export async function usageReport(
  database: Database,
  days: number,
  timeZone: string,
  now: Date = new Date(),
): Promise<UsageReport> {
  const from = new Date(now.getTime() - days * 86_400_000);
  const before = new Date(from.getTime() - days * 86_400_000);
  const events = eventsBetween(from, now);
  const spend = spendBetween(from, now);
  // People, with their role when it is still active
  const people = sql`
    select u.id, u.display_name, u.email, r.code as role
    from users u
    left join roles r on r.id = u.primary_role_id and r.active
    where not u.is_service`;

  const [totals, previous, channels, persons, services, roles, tools, daily, inactive, ratings] =
    // One read-only snapshot on one connection: the parts agree with each other whatever is
    // being written meanwhile, and a long window never takes the pool from the chat
    await database.transaction(
      (db) =>
        Promise.all([
          totalsBetween(db, from, now),
          totalsBetween(db, before, from),
          db.execute(sql`
        with events as (${events})
        select channel, count(*)::int as total from events group by channel`),
          // Everyone who did something of their own or caused a cost, so the rows add up to the totals
          db.execute(sql`
        with events as (${events}), spend as (${spend}),
        tools as (
          select user_id, count(*)::int as calls from tool_calls
          where created_at >= ${from} and created_at < ${now} group by user_id
        ),
        acts as (
          select user_id,
            count(*) filter (where channel = 'chat')::int as questions,
            count(*) filter (where channel = 'mcp')::int as mcp,
            count(*) filter (where channel = 'trials')::int as trials,
            count(*) filter (where channel = 'runs')::int as runs,
            max(created_at) as last
          from events where channel <> 'apps' group by user_id
        ),
        people as (${people})
        select p.id, p.display_name, p.email, p.role,
          coalesce(a.questions, 0) as questions, coalesce(a.mcp, 0) as mcp,
          coalesce(a.trials, 0) as trials, coalesce(a.runs, 0) as runs,
          coalesce(t.calls, 0) as tools, coalesce(s.cost, 0)::bigint as cost,
          coalesce(s.tokens, 0)::bigint as tokens, a.last
        from people p
        left join acts a on a.user_id = p.id
        left join spend s on s.user_id = p.id
        left join tools t on t.user_id = p.id
        where a.user_id is not null or s.user_id is not null
        order by coalesce(a.questions, 0) + coalesce(a.mcp, 0) desc, p.id`),
          db.execute(sql`
        with events as (${events}), spend as (${spend})
        select u.id, u.display_name, u.email,
          (select count(*) from events e where e.user_id = u.id)::int as events,
          coalesce(s.cost, 0)::bigint as cost, coalesce(s.tokens, 0)::bigint as tokens
        from users u
        left join spend s on s.user_id = u.id
        where u.is_service
          and (u.deleted_at is null or s.user_id is not null or exists (select 1 from events e where e.user_id = u.id))
        order by u.display_name, u.id`),
          db.execute(sql`
        with events as (${events}), people as (${people})
        select p.role,
          count(distinct p.id)::int as people,
          count(*) filter (where e.channel = 'chat')::int as questions,
          count(*) filter (where e.channel = 'mcp')::int as mcp
        from people p
        join events e on e.user_id = p.id and e.channel <> 'apps'
        group by p.role
        order by people desc, p.role`),
          db.execute(sql`
        with calls as (
          select * from tool_calls where created_at >= ${from} and created_at < ${now}
        ),
        used as (
          select w.*, u.users from calls w
          join (
            select c.tool_name, count(distinct c.user_id) filter (where not u.is_service) as users
            from calls c join users u on u.id = c.user_id
            group by c.tool_name
          ) u using (tool_name)
        )
        select case when users >= ${MIN_PEOPLE_PER_TOOL} then tool_name end as tool,
          count(*)::int as calls,
          count(*) filter (where not success)::int as errors,
          round(avg(duration_ms))::int as avg_ms,
          count(*) filter (where truncated)::int as truncated
        from used
        group by 1
        order by tool nulls last, calls desc`),
          db.execute(sql`
        with events as (${events})
        select to_char(created_at at time zone ${timeZone}, 'YYYY-MM-DD') as day,
          count(*) filter (where channel = 'chat')::int as questions,
          count(*) filter (where channel = 'mcp')::int as mcp
        from events
        where channel in ('chat', 'mcp')
        group by day
        order by day`),
          // People who may chat, by their role or an extra scope in force at the end of the window,
          // and did nothing of their own in it
          db.execute(sql`
        with events as (${events}), people as (${people}),
        allowed as (
          select u.id from users u
          join roles r on r.id = u.primary_role_id and r.active
          join role_scopes rs on rs.role_id = r.id
          join scopes s on s.id = rs.scope_id and s.code = 'chat.use' and s.deleted_at is null
          union
          select ue.user_id from user_extra_scopes ue
          join scopes s on s.id = ue.scope_id and s.code = 'chat.use' and s.deleted_at is null
          where ue.expires_at is null or ue.expires_at > ${now}
        )
        select p.id, p.display_name, p.email, p.role
        from people p
        join users u on u.id = p.id and u.active and u.deleted_at is null
        where p.id in (select id from allowed)
          and not exists (select 1 from events e where e.user_id = p.id and e.channel <> 'apps')
        order by p.display_name, p.id`),
          db.execute(sql`
        select count(*)::int as total, avg(mr.stars)::float as average
        from message_ratings mr
        join users u on u.id = mr.user_id and not u.is_service
        where mr.created_at >= ${from} and mr.created_at < ${now}`),
        ]),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );

  const byChannel = Object.fromEntries(CHANNELS.map((channel) => [channel, 0])) as Record<
    Channel,
    number
  >;
  for (const row of channels.rows as { channel: Channel; total: number }[]) {
    byChannel[row.channel] = row.total;
  }
  const rated = ratings.rows[0] as { total: number; average: number | null };

  return {
    period: { from: from.toISOString(), to: now.toISOString(), days },
    totals,
    previous,
    byChannel,
    byPerson: (persons.rows as Record<string, unknown>[]).map((row) => ({
      userId: Number(row.id),
      name: String(row.display_name),
      email: String(row.email),
      role: (row.role as string | null) ?? null,
      questions: Number(row.questions),
      mcpCalls: Number(row.mcp),
      trials: Number(row.trials),
      runs: Number(row.runs),
      toolCalls: Number(row.tools),
      costUsd: Number(row.cost) / 1_000_000,
      tokens: Number(row.tokens),
      lastActivity: row.last ? new Date(row.last as string).toISOString() : null,
    })),
    services: (services.rows as Record<string, unknown>[]).map((row) => ({
      userId: Number(row.id),
      name: String(row.display_name),
      email: String(row.email),
      events: Number(row.events),
      costUsd: Number(row.cost) / 1_000_000,
      tokens: Number(row.tokens),
    })),
    byRole: (roles.rows as Record<string, unknown>[]).map((row) => ({
      role: (row.role as string | null) ?? null,
      activePeople: Number(row.people),
      questions: Number(row.questions),
      mcpCalls: Number(row.mcp),
    })),
    byTool: (tools.rows as Record<string, unknown>[]).map((row) => ({
      tool: (row.tool as string | null) ?? null,
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
