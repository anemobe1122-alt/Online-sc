import { createClient } from "npm:@supabase/supabase-js@2";

const encoder = new TextEncoder();
const corsHeaders = {
  "Access-Control-Allow-Origin": "https://anemobe1122-alt.github.io",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function json(data: unknown, status = 200, cors = true) {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  if (cors) for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
  return new Response(JSON.stringify(data), { status, headers });
}

function randomToken(bytes = 24) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const item of data) binary += String.fromCharCode(item);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function makeCode() {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return String(value[0] % 1_000_000).padStart(6, "0");
}

function getServiceKey() {
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    const keys = JSON.parse(secretKeys) as Record<string, string>;
    if (keys.default) return keys.default;
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
}

async function codeHash(registrationId: string, code: string, pepper: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${registrationId}:${code}`));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sendBotMessage(chatId: string, text: string) {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) throw new Error("Telegram bot token is not configured");
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!response.ok) throw new Error("Telegram message delivery failed");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const origin = request.headers.get("Origin");
  const isWebhook = !origin;
  if (isWebhook) {
    if (request.method !== "POST" || !envSecret("TELEGRAM_WEBHOOK_SECRET") ||
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== envSecret("TELEGRAM_WEBHOOK_SECRET")) {
      return json({ error: "Unauthorized" }, 401, false);
    }
  } else if (origin !== corsHeaders["Access-Control-Allow-Origin"]) {
    return json({ error: "Origin not allowed" }, 403);
  }

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400, !isWebhook); }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = getServiceKey();
  if (!supabaseUrl || !serviceKey) return json({ error: "Supabase is not configured" }, 503, !isWebhook);
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    if (isWebhook) {
      const update = body as { message?: { text?: string; chat?: { id?: number | string; type?: string }; from?: { id?: number | string; first_name?: string; username?: string } } };
      const message = update.message;
      if (!message || message.chat?.type !== "private" || message.chat.id == null || message.from?.id == null) return json({ ok: true }, 200, false);
      const chatId = String(message.chat.id);
      const match = String(message.text || "").match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{24,64})\s*$/);
      if (!match) {
        await sendBotMessage(chatId, "Чтобы получить код регистрации, начните регистрацию на сайте и откройте выданную ссылку.");
        return json({ ok: true }, 200, false);
      }

      const registrationId = match[1];
      const { data: existing } = await db.from("telegram_registration_challenges")
        .select("id,status,expires_at").eq("id", registrationId).maybeSingle();
      if (!existing || new Date(existing.expires_at).getTime() <= Date.now()) {
        await sendBotMessage(chatId, "Ссылка истекла. Вернитесь на сайт и начните регистрацию заново.");
        return json({ ok: true }, 200, false);
      }
      if (existing.status === "code_sent") {
        await sendBotMessage(chatId, "Код уже отправлен сюда. Введите его на сайте.");
        return json({ ok: true }, 200, false);
      }
      if (existing.status !== "pending") {
        await sendBotMessage(chatId, "Эта ссылка уже использована. Начните регистрацию на сайте заново.");
        return json({ ok: true }, 200, false);
      }

      const code = makeCode();
      const pepper = Deno.env.get("TELEGRAM_CODE_PEPPER");
      if (!pepper) return json({ error: "Code service is not configured" }, 503, false);
      const now = new Date();
      const { data: claimed, error } = await db.from("telegram_registration_challenges").update({
        status: "code_sent",
        telegram_user_id: String(message.from.id),
        telegram_username: message.from.username || null,
        first_name: message.from.first_name || "Ученик",
        code_hash: await codeHash(registrationId, code, pepper),
        code_expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
      }).eq("id", registrationId).eq("status", "pending").gt("expires_at", now.toISOString()).select("id").maybeSingle();
      if (error) throw error;
      if (!claimed) {
        await sendBotMessage(chatId, "Ссылка уже использована или истекла. Начните регистрацию на сайте заново.");
        return json({ ok: true }, 200, false);
      }

      try {
        await sendBotMessage(chatId, `Код для регистрации в Онлайн-школе: ${code}\nКод действует 5 минут. Никому его не сообщайте.`);
      } catch (error) {
        await db.from("telegram_registration_challenges").update({ status: "expired", code_hash: null }).eq("id", registrationId);
        throw error;
      }
      return json({ ok: true }, 200, false);
    }

    const action = body.action;
    if (action === "start") {
      const registrationId = randomToken();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await db.from("telegram_registration_challenges").delete().lt("expires_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      const { error } = await db.from("telegram_registration_challenges").insert({ id: registrationId, status: "pending", expires_at: expiresAt });
      if (error) throw error;
      return json({ status: "pending", botUrl: `https://t.me/${Deno.env.get("TELEGRAM_BOT_USERNAME") || "OnlineSchoolOgBot"}?start=${registrationId}`, registrationId });
    }

    if (action === "verify") {
      const registrationId = String(body.registrationId || "");
      const code = String(body.code || "").trim();
      if (!/^[A-Za-z0-9_-]{24,64}$/.test(registrationId) || !/^\d{6}$/.test(code)) return json({ error: "Введите шестизначный код из Telegram." }, 400);
      const { data: registration, error: readError } = await db.from("telegram_registration_challenges")
        .select("status,expires_at,code_expires_at,attempts").eq("id", registrationId).maybeSingle();
      if (readError) throw readError;
      if (!registration || registration.status === "expired" || new Date(registration.expires_at).getTime() <= Date.now()) return json({ status: "expired" });
      if (registration.status === "pending") return json({ status: "awaiting_telegram" });
      if (registration.status === "locked") return json({ status: "locked" });
      if (registration.status === "complete") return json({ status: "already_complete" });
      if (registration.status !== "code_sent" || !registration.code_expires_at || new Date(registration.code_expires_at).getTime() <= Date.now()) return json({ status: "expired" });
      const pepper = Deno.env.get("TELEGRAM_CODE_PEPPER");
      if (!pepper) return json({ error: "Code service is not configured" }, 503);
      const { data, error } = await db.rpc("verify_telegram_registration", {
        p_registration_id: registrationId,
        p_code_hash: await codeHash(registrationId, code, pepper),
      });
      if (error) throw error;
      return json(data);
    }

    return json({ error: "Not found" }, 404);
  } catch (error) {
    console.error("telegram-registration", error);
    return json({ error: "Registration service failed. Please retry." }, 500, !isWebhook);
  }
});

function envSecret(name: string) {
  return Deno.env.get(name);
}

