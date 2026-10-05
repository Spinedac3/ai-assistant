import { readFileSync } from "node:fs";
import nodemailer from "nodemailer";

export interface Mail {
  to: string;
  subject: string;
  // Plain text; the HTML part is the same text, escaped
  text: string;
  // Where an answer goes, when not to the sending address
  replyTo?: string;
}

export type SendMail = (mail: Mail) => Promise<void>;

export interface SmtpConfig {
  host: string;
  port: number;
  from: string;
  user?: string;
  passwordFile?: string;
  // Only for a local catcher such as Mailpit: allows a server without TLS
  insecure?: boolean;
}

// A server that accepts the connection and then never answers would hold the worker forever
const SMTP_TIMEOUT_MS = 30_000;

/**
 * Writes plain text as HTML that shows the same: escaped, with its line breaks
 *
 * @param   text  Text
 *
 * @return  The HTML
 */
export function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  return `<div style="font-family: sans-serif; white-space: pre-wrap">${escaped}</div>`;
}

/**
 * Builds the sender of mail through an SMTP server
 *
 * @param   config  Server, sender address and credentials
 *
 * @return  A function that sends one mail and throws when the server refuses it
 */
export function smtpMailer(config: SmtpConfig): SendMail {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    // 465 speaks TLS from the start; any other port upgrades with STARTTLS
    secure: config.port === 465,
    // Reset links and passwords never travel in clear text, even through a relay without login
    requireTLS: config.port !== 465 && !config.insecure,
    auth:
      config.user !== undefined
        ? {
            user: config.user,
            pass: config.passwordFile ? readFileSync(config.passwordFile, "utf8").trim() : "",
          }
        : undefined,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });

  return async (mail) => {
    await transport.sendMail({
      from: config.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: textToHtml(mail.text),
      replyTo: mail.replyTo,
    });
  };
}
