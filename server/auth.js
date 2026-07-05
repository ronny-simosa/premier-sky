// ===========================================================================
// Autenticación Premier Sky · email del equipo + código OTP por SMTP
// ===========================================================================
import crypto from "crypto";

const SESSION_COOKIE = "premier_session";
const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_HOURS = parseInt(process.env.SESSION_HOURS, 10) || 3;
const SESSION_TTL_MS = SESSION_HOURS * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 5;

const sessions = new Map(); // sid -> { email, expires }
const pendingCodes = new Map(); // email -> { code, expires, attempts }
const rateBuckets = new Map(); // key -> { count, reset }

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function loadTeamEmails() {
  const fromEnv = String(process.env.PREMIER_TEAM_EMAILS || "")
    .split(/[,;\s]+/)
    .map(normalizeEmail)
    .filter(Boolean);
  if (fromEnv.length) return new Set(fromEnv);

  const domains = String(process.env.PREMIER_EMAIL_DOMAINS || "")
    .split(/[,;\s]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  return { domainsOnly: domains };
}

function isTeamEmail(email) {
  const norm = normalizeEmail(email);
  if (!norm || !norm.includes("@")) return false;

  const fromEnv = String(process.env.PREMIER_TEAM_EMAILS || "")
    .split(/[,;\s]+/)
    .map(normalizeEmail)
    .filter(Boolean);
  if (fromEnv.includes(norm)) return true;

  const domains = String(process.env.PREMIER_EMAIL_DOMAINS || "")
    .split(/[,;\s]+/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const domain = norm.split("@")[1];
  if (domains.length && domains.some((d) => domain === d || domain.endsWith(`.${d}`))) {
    return true;
  }

  return fromEnv.length > 0 ? false : false;
}

function rateKey(email, ip) {
  return `${normalizeEmail(email)}|${ip || "?"}`;
}

function checkRate(key) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.reset) {
    bucket = { count: 0, reset: now + RATE_WINDOW_MS };
    rateBuckets.set(key, bucket);
  }
  bucket.count++;
  return bucket.count <= RATE_MAX;
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function getSessionId(req) {
  return parseCookies(req)[SESSION_COOKIE] || "";
}

export function getSession(req, res) {
  const sid = getSessionId(req);
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s || Date.now() > s.expires) {
    invalidateSession(req, res);
    return null;
  }
  return s;
}

export function requireAuth(req, res, next) {
  if (process.env.AUTH_DISABLED === "true") {
    req.user = { email: "dev@local" };
    return next();
  }
  const session = getSession(req, res);
  if (!session) {
    return res.status(401).json({
      error: `Tu sesión expiró (${SESSION_HOURS} h). Inicia sesión de nuevo.`,
      sessionExpired: true
    });
  }
  req.user = session;
  next();
}

function setSessionCookie(res, sid) {
  const secure = process.env.COOKIE_SECURE !== "false";
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(sid)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res) {
  const secure = process.env.COOKIE_SECURE !== "false";
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function invalidateSession(req, res) {
  const sid = getSessionId(req);
  if (sid) sessions.delete(sid);
  if (res) clearSessionCookie(res);
}

function generateCode() {
  return String(crypto.randomInt(100000, 999999));
}

function generateSessionId() {
  return crypto.randomBytes(32).toString("hex");
}

export async function requestLoginCode(email, ip, sendMail) {
  const norm = normalizeEmail(email);
  if (!norm) return { ok: true, message: genericMessage() };

  const key = rateKey(norm, ip);
  if (!checkRate(key)) {
    return { ok: false, message: "Demasiados intentos. Espera 15 minutos e inténtalo de nuevo." };
  }

  if (!isTeamEmail(norm)) {
    console.info(`[auth] correo no autorizado (no enviado): ${norm}`);
    return { ok: true, message: genericMessage() };
  }

  const code = generateCode();
  pendingCodes.set(norm, { code, expires: Date.now() + CODE_TTL_MS, attempts: 0 });

  try {
    await sendMail({
      to: norm,
      subject: "Premier Sky · código de acceso",
      text:
        `Tu código de acceso a Premier Sky es: ${code}\n\n` +
        `Válido 10 minutos. Tras entrar, la sesión dura ${SESSION_HOURS} horas.\n` +
        `Si no solicitaste esto, ignora este correo.\n`,
      html:
        `<p>Tu código de acceso a <b>Premier Sky</b> es:</p>` +
        `<p style="font-size:28px;letter-spacing:4px;font-weight:700">${code}</p>` +
        `<p style="color:#666">Válido 10 minutos. Tras entrar, la sesión dura ${SESSION_HOURS} horas.</p>` +
        `<p style="color:#666">Si no solicitaste esto, ignora este correo.</p>`
    });
    console.info(`[auth] código enviado a ${norm}`);
    if (process.env.AUTH_DEBUG === "true") console.info(`[auth] DEBUG código ${code} → ${norm}`);
  } catch (e) {
    pendingCodes.delete(norm);
    console.error("Auth email error:", e.message);
    return { ok: false, message: "No se pudo enviar el correo. Verifica SMTP en server/.env" };
  }

  return { ok: true, message: genericMessage() };
}

function genericMessage() {
  return "Si tu correo pertenece al equipo Premier, recibirás un código en unos minutos.";
}

export function verifyLoginCode(email, code) {
  const norm = normalizeEmail(email);
  const pending = pendingCodes.get(norm);
  if (!pending || Date.now() > pending.expires) {
    return { ok: false, error: "Código inválido o expirado." };
  }
  if (pending.attempts >= 5) {
    pendingCodes.delete(norm);
    return { ok: false, error: "Demasiados intentos. Solicita un código nuevo." };
  }
  pending.attempts++;

  if (String(code).trim() !== pending.code) {
    return { ok: false, error: "Código incorrecto." };
  }

  pendingCodes.delete(norm);
  const sid = generateSessionId();
  sessions.set(sid, { email: norm, expires: Date.now() + SESSION_TTL_MS });
  return { ok: true, sid, email: norm };
}

export function applySessionCookie(res, sid) {
  setSessionCookie(res, sid);
}

export function destroySession(req, res) {
  invalidateSession(req, res);
}

export function sessionDurationHours() {
  return SESSION_HOURS;
}

export function authCookieName() {
  return SESSION_COOKIE;
}

export function pageRequiresAuth(pathname) {
  if (pathname === "/login.html") return false;
  if (pathname === "/" || pathname === "/index.html" || pathname === "/state.html") return true;
  if (pathname.startsWith("/state.html")) return true;
  return false;
}

export function redirectToLogin(res, nextUrl) {
  const q = nextUrl ? `?next=${encodeURIComponent(nextUrl)}` : "";
  res.redirect(302, `/login.html${q}`);
}
