// ===========================================================================
// Autenticación Premier Sky · email del equipo + código OTP por SMTP
// ===========================================================================
import crypto from "crypto";

const SESSION_COOKIE = "premier_session";
const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_HOURS = parseInt(process.env.SESSION_HOURS, 10) || 8;
const SESSION_TTL_MS = SESSION_HOURS * 60 * 60 * 1000;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 5;

function sessionSecret() {
  return (
    process.env.SESSION_SECRET ||
    process.env.RESEND_API_KEY ||
    process.env.JOBNIMBUS_API_KEY ||
    "premier-sky-dev-only"
  );
}

/** Sesiones firmadas en cookie — sobreviven reinicios de Railway (sin Redis). */
const sessions = new Map(); // legacy sid -> { email, expires }
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

function signSessionToken(email, expiresMs) {
  const payload = JSON.stringify({ email: normalizeEmail(email), exp: expiresMs });
  const body = Buffer.from(payload).toString("base64url");
  const sig = crypto.createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || !token.includes(".")) return null;
  const dot = token.indexOf(".");
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!data.email || typeof data.exp !== "number" || Date.now() > data.exp) return null;
    return { email: data.email, expires: data.exp };
  } catch {
    return null;
  }
}

function cookieSecure() {
  if (process.env.COOKIE_SECURE === "true") return true;
  if (process.env.COOKIE_SECURE === "false") return false;
  return !!(process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === "production");
}

export function getSession(req, res) {
  const token = getSessionId(req);
  if (!token) return null;

  const signed = verifySessionToken(token);
  if (signed) return signed;

  const legacy = sessions.get(token);
  if (legacy && Date.now() <= legacy.expires) return legacy;

  if (res) clearSessionCookie(res);
  sessions.delete(token);
  return null;
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
  const secure = cookieSecure();
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
  const secure = cookieSecure();
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
  if (sid && !sid.includes(".")) sessions.delete(sid);
  if (res) clearSessionCookie(res);
}

function generateCode() {
  return String(crypto.randomInt(100000, 999999));
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
    const hint = String(e.message || "").includes("verify a domain")
      ? " Verifica premierchi.com en resend.com/domains y usa RESEND_FROM=sky@premierchi.com"
      : "";
    return { ok: false, message: (e.message || "No se pudo enviar el correo.") + hint };
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
  const expires = Date.now() + SESSION_TTL_MS;
  const sid = signSessionToken(norm, expires);
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

export function contractGeneratorEmails() {
  return String(process.env.CONTRACT_GENERATOR_EMAILS || "sharom@premierchi.com")
    .split(/[,;\s]+/)
    .map(normalizeEmail)
    .filter(Boolean);
}

export function canAccessContractGenerator(email) {
  return contractGeneratorEmails().includes(normalizeEmail(email));
}

export function pageRequiresAuth(pathname) {
  if (pathname === "/login.html") return false;
  if (pathname === "/" || pathname === "/index.html" || pathname === "/sky.html") return true;
  if (pathname === "/state.html" || pathname.startsWith("/state.html")) return true;
  if (pathname === "/contract.html") return true;
  if (pathname === "/sales" || pathname === "/sales/" || pathname.startsWith("/sales/")) return true;
  return false;
}

export function redirectToLogin(res, nextUrl) {
  const q = nextUrl ? `?next=${encodeURIComponent(nextUrl)}` : "";
  res.redirect(302, `/login.html${q}`);
}
