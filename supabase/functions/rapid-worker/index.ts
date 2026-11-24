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

function base64UrlEncode(value: string) {
  return btoa(value).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded + "=".repeat((4 - padded.length % 4) % 4));
}

async function signSession(payload: Record<string, unknown>, secret: string) {
  const body = base64UrlEncode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const encoded = Array.from(new Uint8Array(signature), (byte) => String.fromCharCode(byte)).join("");
  return `${body}.${base64UrlEncode(encoded)}`;
}

async function verifySession(token: string, secret: string) {
  try {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra) return null;
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const signatureBytes = Uint8Array.from(base64UrlDecode(signature), (char) => char.charCodeAt(0));
    if (!await crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(body))) return null;
    const payload = JSON.parse(base64UrlDecode(body)) as Record<string, unknown>;
    if (typeof payload.exp !== "number" || payload.exp <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function validTelegramId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{5,20}$/.test(value);
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
      if (data?.status === "complete" && data.student_id) {
        const { data: student, error: studentError } = await db.from("students")
          .select("id,telegram_user_id").eq("id", data.student_id).maybeSingle();
        if (studentError) throw studentError;
        if (student && validTelegramId(student.telegram_user_id)) {
          const token = await signSession({
            sub: student.id,
            telegram_id: student.telegram_user_id,
            exp: Date.now() + 12 * 60 * 60 * 1000,
          }, pepper);
          return json({ ...data, session: token });
        }
      }
      return json(data);
    }

    const authorization = request.headers.get("Authorization") || "";
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    const session = await verifySession(bearer, Deno.env.get("TELEGRAM_CODE_PEPPER") || "");
    const telegramId = session?.telegram_id;
    const studentId = session?.sub;
    if (!validTelegramId(telegramId) || typeof studentId !== "string") {
      return json({ error: "Требуется войти через Telegram." }, 401);
    }

    const { data: student, error: studentError } = await db.from("students")
      .select("id,telegram_user_id,telegram_username,first_name")
      .eq("id", studentId).eq("telegram_user_id", telegramId).maybeSingle();
    if (studentError) throw studentError;
    if (!student) return json({ error: "Сессия недействительна. Войдите снова." }, 401);

    const [{ data: admin, error: adminError }, { data: access, error: accessError }] = await Promise.all([
      db.from("admins").select("telegram_id").eq("telegram_id", student.telegram_user_id).maybeSingle(),
      db.from("student_access").select("is_active").eq("telegram_id", student.telegram_user_id).maybeSingle(),
    ]);
    if (adminError) throw adminError;
    if (accessError) throw accessError;
    const isAdmin = !!admin;
    const hasAccess = access?.is_active === true;

    if (action === "session" || action === "me") {
      return json({ authenticated: true, name: student.first_name, isAdmin, hasAccess });
    }
    if (action === "logout") return json({ ok: true });

    if (action === "lessons.list") {
      if (!isAdmin && !hasAccess) return json({ error: "schedule_access_required" }, 403);
      const { data: lessons, error } = await db.from("lessons")
        .select("id,subject,topic,description,starts_at")
        .gte("starts_at", new Date().toISOString()).order("starts_at", { ascending: true });
      if (error) throw error;
      return json({ lessons: lessons || [] });
    }

    if (!action || !String(action).startsWith("admin.")) return json({ error: "Not found" }, 404);
    if (!isAdmin) return json({ error: "admin_required" }, 403);

    if (action === "admin.lessons.list") {
      const { data: allLessons, error } = await db.from("lessons")
        .select("id,subject,topic,description,starts_at").order("starts_at", { ascending: true });
      if (error) throw error;
      return json({ lessons: allLessons || [] });
    }

    if (action === "admin.students.list") {
      const { data: students, error } = await db.from("students")
        .select("id,telegram_user_id,telegram_username,first_name,created_at").order("created_at", { ascending: true });
      if (error) throw error;
      const ids = (students || []).map((item) => item.telegram_user_id);
      const { data: accessRows, error: accessReadError } = ids.length
        ? await db.from("student_access").select("telegram_id,is_active").in("telegram_id", ids)
        : { data: [], error: null };
      if (accessReadError) throw accessReadError;
      const accessById = new Map((accessRows || []).map((item) => [item.telegram_id, item.is_active]));
      return json({ students: (students || []).map((item) => ({ ...item, hasAccess: accessById.get(item.telegram_user_id) === true })) });
    }

    if (action === "admin.lesson.save") {
      const subject = String(body.subject || "").trim();
      const topic = String(body.topic || "").trim();
      const description = String(body.description || "").trim();
      const startsAt = String(body.starts_at || "");
      if (!subject || subject.length > 120 || !topic || topic.length > 240 || description.length > 5000 || !Number.isFinite(Date.parse(startsAt))) {
        return json({ error: "Заполните предмет, тему и корректные дату и время." }, 400);
      }
      const values = { subject, topic, description, starts_at: new Date(startsAt).toISOString(), updated_at: new Date().toISOString() };
      const lessonId = Number(body.id);
      const result = Number.isSafeInteger(lessonId) && lessonId > 0
        ? await db.from("lessons").update(values).eq("id", lessonId).select("id,subject,topic,description,starts_at").maybeSingle()
        : await db.from("lessons").insert(values).select("id,subject,topic,description,starts_at").single();
      if (result.error) throw result.error;
      if (!result.data) return json({ error: "Занятие не найдено." }, 404);
      return json({ lesson: result.data });
    }

    if (action === "admin.lesson.delete") {
      const lessonId = Number(body.id);
      if (!Number.isSafeInteger(lessonId) || lessonId < 1) return json({ error: "Некорректный ID занятия." }, 400);
      const { error } = await db.from("lessons").delete().eq("id", lessonId);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "admin.access.set") {
      const targetId = typeof body.telegram_id === "number" ? String(body.telegram_id) : String(body.telegram_id || "");
      if (!validTelegramId(targetId) || typeof body.is_active !== "boolean") {
        return json({ error: "Укажите числовой Telegram ID и статус доступа." }, 400);
      }
      const { data: target, error: targetError } = await db.from("students")
        .select("telegram_user_id,telegram_username").eq("telegram_user_id", targetId).maybeSingle();
      if (targetError) throw targetError;
      if (!target) return json({ error: "Ученик с таким Telegram ID не зарегистрирован." }, 404);
      const { error } = await db.from("student_access").upsert({
        telegram_id: target.telegram_user_id,
        username: target.telegram_username,
        is_active: body.is_active,
      }, { onConflict: "telegram_id" });
      if (error) throw error;
      return json({ ok: true, telegram_id: target.telegram_user_id, is_active: body.is_active });
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


