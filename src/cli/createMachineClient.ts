import { declareMachineClient } from "../auth/machineClients.js";

const [clientId = "", flag] = process.argv.slice(2);
const listPath = process.env.MACHINE_CLIENTS_FILE ?? "secrets/machine-clients.json";

const secretPath = declareMachineClient(listPath, clientId, flag === "--rotate");
console.info(
  `Cliente ${clientId} declarado en ${listPath}; su secreto quedó en ${secretPath}. ` +
    "Cópialo a la máquina del otro sistema y bórralo de aquí. Pon MACHINE_CLIENTS_FILE y reinicia.",
);
