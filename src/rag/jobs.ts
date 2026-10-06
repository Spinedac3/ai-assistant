import { and, eq, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../db/client.js";
import { documentJobs } from "../db/schema.js";
import { parseDocument } from "./document.js";
import { type Index, ingestDocument, removeDocument } from "./ingest.js";
import type { DocumentStorage } from "./storage.js";

export type JobKind = "upload" | "reindex";

export type Job = typeof documentJobs.$inferSelect;

export interface WorkerDependencies {
  db: Database;
  storage: DocumentStorage;
  index: Index;
  logger: FastifyBaseLogger;
  pollMs: number;
}

/**
 * Queues a document to be indexed from its stored markdown
 *
 * @param   db       Own database
 * @param   docCode  Document code
 * @param   kind     First upload or reindex
 * @param   userId   Who asked
 *
 * @return  The job id
 */
export async function enqueue(
  db: Database,
  docCode: string,
  kind: JobKind,
  userId: number,
): Promise<number> {
  const [row] = await db
    .insert(documentJobs)
    .values({ docCode, kind, userId })
    .returning({ id: documentJobs.id });

  if (!row) {
    throw new Error("No se pudo encolar el documento");
  }

  return row.id;
}

/**
 * Reads one job
 *
 * @param   db  Own database
 * @param   id  Job id
 *
 * @return  The job, or null
 */
export async function findJob(db: Database, id: number): Promise<Job | null> {
  const [row] = await db.select().from(documentJobs).where(eq(documentJobs.id, id)).limit(1);

  return row ?? null;
}

/**
 * Takes the oldest queued job; the claim is atomic, so a job is never started twice
 *
 * @param   db  Own database
 *
 * @return  The job now running, or null when the queue is empty
 */
export async function claimNext(db: Database): Promise<Job | null> {
  const result = await db.execute(sql`
    update document_jobs set status = 'running', started_at = now()
    where id = (
      select id from document_jobs where status = 'queued'
      order by created_at, id limit 1 for update skip locked
    )
    returning id`);
  const id = (result.rows[0] as { id?: number } | undefined)?.id;

  return id === undefined ? null : findJob(db, id);
}

/**
 * Closes a running job with its outcome
 *
 * @param   db       Own database
 * @param   id       Job id
 * @param   outcome  Chunks indexed, or the error
 */
async function finish(
  db: Database,
  id: number,
  outcome: { chunks: number } | { error: string },
): Promise<void> {
  await db
    .update(documentJobs)
    .set({
      status: "chunks" in outcome ? "done" : "failed",
      chunks: "chunks" in outcome ? outcome.chunks : null,
      error: "error" in outcome ? outcome.error.slice(0, 2_000) : null,
      finishedAt: sql`now()`,
    })
    .where(and(eq(documentJobs.id, id), eq(documentJobs.status, "running")));
}

/**
 * Fails the jobs a previous process left running; nothing would ever finish them otherwise
 *
 * @param   db  Own database
 */
export async function failInterrupted(db: Database): Promise<void> {
  await db
    .update(documentJobs)
    .set({
      status: "failed",
      error: "El servidor se reinició mientras se indexaba; vuelve a indexarlo",
      finishedAt: sql`now()`,
    })
    .where(eq(documentJobs.status, "running"));
}

/**
 * Indexes one claimed job from its stored markdown
 *
 * @param   deps  Database, storage, index and logger
 * @param   job   Running job
 */
export async function runJob(deps: Omit<WorkerDependencies, "pollMs">, job: Job): Promise<void> {
  try {
    const parsed = parseDocument(await deps.storage.readMarkdown(job.docCode));
    const result = await ingestDocument(deps.index, parsed);
    // Deleted while it was being indexed: the delete removes the originals first, so their absence
    // here means it wins, or the document would come back without them
    if (!(await deps.storage.exists(job.docCode, "md"))) {
      await removeDocument(deps.index, job.docCode);
      throw new Error("El documento se borró mientras se indexaba");
    }

    await finish(deps.db, job.id, { chunks: result.chunks });
    deps.logger.info({ job: job.id, doc: job.docCode, ...result }, "document indexed");
  } catch (error) {
    await finish(deps.db, job.id, { error: (error as Error).message });
    deps.logger.error({ err: error, job: job.id, doc: job.docCode }, "document indexing failed");
  }
}

/**
 * Starts the worker that drains the queue, one job at a time
 *
 * @param   deps  Database, storage, index, logger and poll interval
 *
 * @return  A function that stops it and resolves once the job in progress ends
 */
export function startWorker(deps: WorkerDependencies): () => Promise<void> {
  // The next round is scheduled only after the previous one ends, so a slow document never
  // overlaps with the next poll. There is one worker per deployment: at start it fails whatever a
  // previous process left running.
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> = Promise.resolve();

  const round = async () => {
    try {
      // Checked before each claim, so a stopping worker never takes a job it would abandon
      while (!stopped) {
        const job = await claimNext(deps.db);
        if (!job) {
          break;
        }

        await runJob(deps, job);
      }
    } catch (error) {
      deps.logger.error({ err: error }, "document worker round failed");
    }

    if (!stopped) {
      timer = setTimeout(() => {
        current = round();
      }, deps.pollMs);
    }
  };

  current = failInterrupted(deps.db)
    .catch((error) => deps.logger.error({ err: error }, "could not fail interrupted jobs"))
    .then(round);

  return async () => {
    stopped = true;
    clearTimeout(timer);
    await current;
  };
}
