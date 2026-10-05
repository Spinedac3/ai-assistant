import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { smtpMailer } from "../../src/notices/mailer.js";
import { MAILPIT_SMTP, mailsTo } from "./support/mailpit.js";

describe("mailer", () => {
  it("sends plain text with an escaped HTML copy, and fails loudly when the server is not there or cannot encrypt", async () => {
    // Performs the test.
    const to = `ana-${randomBytes(4).toString("hex")}@example.com`;
    await smtpMailer(MAILPIT_SMTP)({
      to,
      subject: "Entregas tardías",
      text: "Hoy hubo 3 <tardías>.\nRevisa la ruta & el piloto.",
    });
    const mails = await mailsTo(to);

    // Performs assertions.
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      subject: "Entregas tardías",
      text: "Hoy hubo 3 <tardías>.\nRevisa la ruta & el piloto.",
      from: "asistente@example.com",
    });
    expect(mails[0]?.html).toContain(
      "Hoy hubo 3 &lt;tardías&gt;.\nRevisa la ruta &amp; el piloto.",
    );
    await expect(
      smtpMailer({ ...MAILPIT_SMTP, port: 1 })({ to, subject: "x", text: "x" }),
    ).rejects.toThrow("ECONNREFUSED");
    // Without the opt-out, a server that cannot encrypt gets nothing
    await expect(
      smtpMailer({ ...MAILPIT_SMTP, insecure: false })({ to, subject: "x", text: "x" }),
    ).rejects.toThrow("STARTTLS");
    expect(await mailsTo(to)).toHaveLength(1);
  });
});
