import { env } from '../config/env.js';

// Every email the system sends goes through this file.
// Development: the email is printed in the terminal, nothing leaves your computer.
// Production (later): replace the body of sendEmail() with a call to a real provider
// (Resend, Brevo, SMTP). Nothing else in the project needs to change.

export interface InvitationEmail {
  to: string;
  companyName: string;
  inviterName: string;
  role: string;
  link: string;
  expiresAt: Date;
}

async function sendEmail(
  to: string,
  subject: string,
  text: string,
): Promise<void> {
  if (env.NODE_ENV === 'test') return; // keep test output clean
  console.log(`\n--------- EMAIL (development: not really sent)---------\nTo: ${to}\nSubject: ${subject}\n\n${text}\n----------------------------------------\n`);
}

export async function sendInvitationEmail(e: InvitationEmail): Promise<void> {
  const subject = `${e.inviterName} invited you to ${e.companyName} on Taabile`;
  const text = [
    `Hello,`,
    ``,
    `${e.inviterName} invited you to join ${e.companyName} as a ${e.role}.`,
    `Open this link to set your password and sign in:`,
    e.link,
    ``,
    `The link works once and expires on ${e.expiresAt.toUTCString()}.`,
  ].join(`\n`);
  await sendEmail(e.to, subject, text);
}