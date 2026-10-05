import type { Database } from "../../db/client.js";
import {
  enqueueNotices,
  NOTICES_PER_RECIPIENT_HOUR,
  type NoticeRequest,
} from "../../notices/outbox.js";
import type { Tool } from "../contract.js";

export const SEND_NOTICE = "send_notice";

// A list of people: as many as a team or a distribution list holds
const MAX_NOTICES = 200;
const MAX_MESSAGE = 20_000;

/**
 * Builds the tool that queues notices by mail to accounts of the assistant
 *
 * @param   db  Own database
 *
 * @return  The tool
 */
export function sendNoticeTool(db: Database): Tool {
  return {
    definition: {
      name: SEND_NOTICE,
      description:
        "Sends notices by mail to people who have an account in this assistant. Each notice " +
        "carries a key you choose: the same key sent again is not delivered twice, so retrying " +
        "is safe. Delivery happens in the background and is retried if the mail server fails. " +
        `A person receives at most ${NOTICES_PER_RECIPIENT_HOUR} notices an hour. Each notice comes back as ` +
        "queued, duplicate (key already used), unknown_recipient (no active account with that " +
        "address) or over_quota.",
      inputSchema: {
        type: "object",
        properties: {
          notices: {
            type: "array",
            minItems: 1,
            maxItems: MAX_NOTICES,
            items: {
              type: "object",
              properties: {
                key: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,100}$" },
                to: {
                  type: "string",
                  minLength: 3,
                  maxLength: 255,
                  description: "Address of the account.",
                },
                // A line break in a subject would start a new mail header
                subject: { type: "string", minLength: 1, maxLength: 200, pattern: "^[^\\r\\n]+$" },
                message: {
                  type: "string",
                  minLength: 1,
                  maxLength: MAX_MESSAGE,
                  description: "Plain text.",
                },
              },
              required: ["key", "to", "subject", "message"],
              additionalProperties: false,
            },
          },
        },
        required: ["notices"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          notices: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                to: { type: "string" },
                outcome: {
                  type: "string",
                  enum: ["queued", "duplicate", "unknown_recipient", "over_quota"],
                },
              },
              required: ["key", "to", "outcome"],
            },
          },
          queued: { type: "integer" },
        },
        required: ["notices", "queued"],
      },
      requiredScopes: ["notices.send"],
      readOnly: false,
    },
    execute: async (args, context) => {
      const requests = (args as { notices: NoticeRequest[] }).notices;
      const outcomes = await enqueueNotices(db, context.userId, requests);
      const results = requests.map((request, index) => ({
        key: request.key,
        to: request.to,
        outcome: outcomes[index] ?? "unknown_recipient",
      }));

      return {
        ok: true,
        data: {
          notices: results,
          queued: outcomes.filter((outcome) => outcome === "queued").length,
        },
        rows: results.length,
      };
    },
  };
}
