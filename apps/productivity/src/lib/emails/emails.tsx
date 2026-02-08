import React from "react";
import { Resend } from "resend";
import { getContext } from "../context";
import MagicLinkEmail, { type MagicLinkEmailProps } from "./magic-link.email";

React;

type SendEmailProps<TemplateProps> = TemplateProps & {
  to: string;
  from?: string;
};

export class EmailService {
  private readonly resend: Resend | null;

  constructor(resendApiKey: string) {
    if (resendApiKey) {
      this.resend = new Resend(resendApiKey);
    } else {
      this.resend = null;
    }
  }

  async sendMagicLinkEmail(
    opts: SendEmailProps<MagicLinkEmailProps>,
  ): Promise<{ success: true; error: undefined } | { success: false; error: string }> {
    const { to, from, ...props } = opts;

    if (!this.resend) {
      console.warn("Resend API key is not set, skipping email");
      console.warn("Email data", JSON.stringify(opts, null, 2));
      return { success: true, error: undefined };
    }

    const result = await this.resend.emails.send({
      from: from ?? "noreply@email.krolebord.com",
      to,
      subject: "Your login link",
      react: <MagicLinkEmail {...props} />,
    });

    const success = !!result.data;
    const error = result.error?.message ?? result.error?.name ?? "Unknown error";

    if (success) {
      return { success: true, error: undefined };
    }

    return { success: false, error };
  }
}

export const emailService = new EmailService(getContext()?.RESEND_API_KEY ?? "");
