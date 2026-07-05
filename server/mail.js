// ===========================================================================
// Envío de correo · Resend (Railway/producción) o SMTP (local)
// ===========================================================================
import nodemailer from "nodemailer";

let transporter = null;

function createTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return null;
  const port = parseInt(process.env.SMTP_PORT, 10) || 465;
  const secure = process.env.SMTP_SECURE === "true" || port === 465;
  return nodemailer.createTransport({
    host: String(process.env.SMTP_HOST).trim(),
    port,
    secure,
    auth: {
      user: String(process.env.SMTP_USER).trim(),
      pass: process.env.SMTP_PASS
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    tls: { servername: String(process.env.SMTP_HOST).trim() }
  });
}

function mailFrom() {
  return (
    process.env.RESEND_FROM ||
    process.env.SMTP_FROM ||
    process.env.SMTP_USER ||
    "Premier Sky <onboarding@resend.dev>"
  );
}

function normalizeTo(to) {
  return Array.isArray(to) ? to : [to];
}

export function initMail() {
  if (process.env.RESEND_API_KEY) {
    console.log("✓ Correo vía Resend API (" + mailFrom() + ")");
    return;
  }
  transporter = createTransporter();
  if (transporter) {
    transporter.verify().then(
      () => console.log("✓ SMTP listo (" + process.env.SMTP_HOST + ":" + (process.env.SMTP_PORT || 465) + ")"),
      (e) => console.warn("⚠ SMTP no verifica:", e.message)
    );
  } else {
    console.warn("⚠ Correo no configurado — define RESEND_API_KEY o SMTP_* en server/.env");
  }
}

export function mailConfigured() {
  return !!(process.env.RESEND_API_KEY || transporter);
}

export function mailProvider() {
  if (process.env.RESEND_API_KEY) return "resend";
  if (transporter) return "smtp";
  return null;
}

async function sendViaResend({ to, subject, text, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY no configurada");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: mailFrom(),
      to: normalizeTo(to),
      subject,
      text,
      html
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || data.error || res.statusText || "Error Resend";
    throw new Error(msg);
  }
  return { messageId: data.id };
}

async function sendViaSmtp({ to, subject, text, html }) {
  if (!transporter) throw new Error("SMTP no configurado en server/.env");
  return transporter.sendMail({ from: mailFrom(), to, subject, text, html });
}

export async function sendMail(opts) {
  if (process.env.RESEND_API_KEY) return sendViaResend(opts);
  return sendViaSmtp(opts);
}
