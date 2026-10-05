import type { Cores } from "../../src/rag/ingest.js";

/**
 * Calls the Solr core admin API
 *
 * @param   solrUrl  Server address
 * @param   params   Action and its parameters
 *
 * @return  The response
 */
async function coreAdmin(solrUrl: string, params: Record<string, string>): Promise<Response> {
  return fetch(`${solrUrl}/solr/admin/cores?${new URLSearchParams({ ...params, wt: "json" })}`);
}

/**
 * Creates an empty pair of cores with the real schema, so tests never touch the development ones
 *
 * @param   solrUrl  Server address
 * @param   prefix   Name prefix of the pair
 *
 * @return  The core names
 */
export async function createCores(solrUrl: string, prefix: string): Promise<Cores> {
  const cores = { current: `${prefix}_docs`, historical: `${prefix}_docs_historical` };

  for (const name of Object.values(cores)) {
    await coreAdmin(solrUrl, { action: "UNLOAD", core: name, deleteInstanceDir: "true" });
    const response = await coreAdmin(solrUrl, { action: "CREATE", name, configSet: "docs" });
    if (!response.ok) {
      throw new Error(`No se pudo crear el core ${name}: ${await response.text()}`);
    }
  }

  return cores;
}

/**
 * Removes a pair of test cores with their data
 *
 * @param   solrUrl  Server address
 * @param   cores    Core names
 */
export async function dropCores(solrUrl: string, cores: Cores): Promise<void> {
  for (const name of Object.values(cores)) {
    await coreAdmin(solrUrl, { action: "UNLOAD", core: name, deleteInstanceDir: "true" });
  }
}
