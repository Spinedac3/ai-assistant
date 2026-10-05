const TIMEOUT_MS = 30_000;

export interface SolrQuery {
  query: string;
  filter?: string[];
  fields?: string[];
  limit?: number;
  sort?: string;
}

export class SolrError extends Error {}

/**
 * Escapes a value so Solr reads it as one literal term, never as query syntax
 *
 * @param   value  Raw value
 *
 * @return  The escaped value
 */
export function escapeTerm(value: string): string {
  return value.replace(/([+\-!(){}[\]^"~*?:\\/&| ])/g, "\\$1");
}

export class Solr {
  /**
   * Builds a client for one Solr server
   *
   * @param   baseUrl  Server address, without /solr
   */
  constructor(private readonly baseUrl: string) {}

  /**
   * Runs a query and returns the matching documents
   *
   * @param   core   Core to query
   * @param   query  Query, filters, fields, limit and sort
   *
   * @return  The documents, best first
   */
  async query<T = Record<string, unknown>>(core: string, query: SolrQuery): Promise<T[]> {
    const response = await this.send(`${core}/query`, {
      query: query.query,
      filter: query.filter ?? [],
      fields: (query.fields ?? ["*", "score"]).join(","),
      limit: query.limit ?? 10,
      ...(query.sort ? { sort: query.sort } : {}),
    });

    return ((response as { response?: { docs?: T[] } }).response?.docs ?? []) as T[];
  }

  /**
   * Adds or replaces documents, one per request: Solr 9 intermittently fails a batch of vectors
   *
   * @param   core       Core to write
   * @param   documents  Documents to add
   */
  async add(core: string, documents: Array<Record<string, unknown>>): Promise<void> {
    for (const document of documents) {
      await this.send(`${core}/update/json/docs`, [document]);
    }
  }

  /**
   * Deletes every document matching a query; nothing matching is not an error
   *
   * @param   core   Core to write
   * @param   query  Query with every value already escaped
   */
  async deleteWhere(core: string, query: string): Promise<void> {
    await this.send(`${core}/update`, { delete: { query } });
  }

  /**
   * Makes the latest writes visible to queries
   *
   * @param   core  Core to commit
   */
  async commit(core: string): Promise<void> {
    await this.send(`${core}/update?commit=true`, {});
  }

  /**
   * Discards the writes sent since the last commit
   *
   * @param   core  Core to roll back
   */
  async rollback(core: string): Promise<void> {
    await this.send(`${core}/update`, { rollback: {} });
  }

  /**
   * Posts JSON to a core endpoint and checks the answer
   *
   * @param   path  Path under /solr/
   * @param   body  JSON body
   *
   * @return  The parsed answer
   */
  private async send(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/solr/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new SolrError(`Solr no respondió (${path}): ${(error as Error).message}`);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new SolrError(`Solr respondió ${response.status} (${path}): ${text.slice(0, 300)}`);
    }

    const parsed = JSON.parse(text) as { responseHeader?: { status?: number } };
    if (parsed.responseHeader?.status !== undefined && parsed.responseHeader.status !== 0) {
      throw new SolrError(`Solr devolvió status ${parsed.responseHeader.status} (${path})`);
    }

    return parsed;
  }
}
