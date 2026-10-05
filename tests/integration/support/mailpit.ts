const MAILPIT = process.env.MAILPIT_URL ?? "http://localhost:8025";

export const MAILPIT_SMTP = {
  host: "localhost",
  port: 1025,
  from: "Asistente <asistente@example.com>",
};

export interface CaughtMail {
  subject: string;
  text: string;
  html: string;
  from: string;
}

/**
 * Reads every mail Mailpit caught for an address, oldest first
 *
 * @param   to  Address
 *
 * @return  The mails
 */
export async function mailsTo(to: string): Promise<CaughtMail[]> {
  const search = (await (
    await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)
  ).json()) as { messages: { ID: string }[] };

  const mails: CaughtMail[] = [];
  for (const { ID } of search.messages.reverse()) {
    const message = (await (await fetch(`${MAILPIT}/api/v1/message/${ID}`)).json()) as {
      Subject: string;
      Text: string;
      HTML: string;
      From: { Address: string };
    };
    mails.push({
      subject: message.Subject,
      // SMTP carries CRLF line ends
      text: message.Text.replaceAll("\r\n", "\n"),
      html: message.HTML.replaceAll("\r\n", "\n"),
      from: message.From.Address,
    });
  }

  return mails;
}
