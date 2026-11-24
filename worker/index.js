const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=/g, "").split("+").join("-").split("/").join("_");
}
function fromB64url(value) {
  const s = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(s + "=".repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
function jsonB64(value) { return b64url(encoder.encode(JSON.stringify(value))); }
async function hmac(value, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign","verify"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}
async function signValue(value, secret) {
  const body = jsonB64(value);
  return body + "." + b64url(await hmac(body, secret));
}
async function verifyValue(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [body, signature] = token.split(".");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["verify"]);
  const ok = await crypto.subtle.verify("HMAC", key, fromB64url(signature), encoder.encode(body));
  if (!ok) return null;
  try { return JSON.parse(decoder.decode(fromB64url(body))); } catch { return null; }
}
function cookie(request, name) {
  const all = request.headers.get("Cookie") || "";
  const item = all.split(";").map(x=>x.trim()).find(x=>x.startsWith(name+"="));
  return item ? decodeURIComponent(item.slice(name.length+1)) : null;
}
function setCookie(value, maxAge) {
  return `oidc_state=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
function clearCookie() { return "oidc_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"; }
function corsHeaders(origin, env) {
  const allowed = env.FRONTEND_URL;
  const h = new Headers({"Vary":"Origin","Access-Control-Allow-Methods":"GET, POST, OPTIONS","Access-Control-Allow-Headers":"Authorization, Content-Type"});
  if (origin && origin === allowed) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Access-Control-Allow-Credentials","true");
  }
  return h;
}
function responseJson(data, status=200, headers={}) {
  return new Response(JSON.stringify(data), {status, headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...headers}});
}
async function verifyTelegramIdToken(token, env) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid ID token");
  const header = JSON.parse(decoder.decode(fromB64url(parts[0])));
  const claims = JSON.parse(decoder.decode(fromB64url(parts[1])));
  if (header.alg !== "RS256") throw new Error("Unexpected signing algorithm");
  const jwksResponse = await fetch("https://oauth.telegram.org/.well-known/jwks.json");
  if (!jwksResponse.ok) throw new Error("Unable to load Telegram signing keys");
  const jwks = await jwksResponse.json();
  const jwk = jwks.keys.find(k => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) throw new Error("Unknown Telegram signing key");
  const key = await crypto.subtle.importKey("jwk", jwk, {name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"}, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(parts[2]), encoder.encode(parts[0]+"."+parts[1]));
  const now = Math.floor(Date.now()/1000);
  const audienceOk = Array.isArray(claims.aud) ? claims.aud.includes(env.CLIENT_ID) : String(claims.aud) === String(env.CLIENT_ID);
  if (!valid || claims.iss !== "https://oauth.telegram.org" || !audienceOk || !claims.exp || claims.exp <= now || claims.iat > now + 60) {
    throw new Error("Telegram ID token validation failed");
  }
  return claims;
}

function randomToken(size = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(size)));
}
async function sha256(value) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
async function sendBotMessage(env, chatId, text) {
  if (!env.BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({chat_id:chatId,text})
  });
}
async function completeTelegramRegistration(update, env) {
  const message = update.message;
  if (!message || message.chat?.type !== "private" || !message.from?.id) return;
  const chatId = String(message.chat.id);
  const telegramId = String(message.from.id);
  const text = String(message.text || "");
  const start = text.match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{40,60})\s*$/);
  if (!start) {
    await sendBotMessage(env, chatId, "Чтобы создать аккаунт ученика, начните регистрацию на сайте Онлайн-школы и перейдите по ссылке сюда.");
    return;
  }
  const registrationHash = await sha256(start[1]);
  const pending = await env.DB.prepare("SELECT status, expires_at FROM telegram_registrations WHERE id_hash = ?")
    .bind(registrationHash).first();
  if (!pending || pending.status !== "pending" || Date.parse(pending.expires_at) <= Date.now()) {
    await sendBotMessage(env, chatId, "Ссылка регистрации истекла. Вернитесь на сайт и начните регистрацию заново.");
    return;
  }

  const firstName = String(message.from.first_name || "Ученик").slice(0, 120);
  const username = message.from.username ? String(message.from.username).slice(0, 120) : null;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO students (telegram_user_id, first_name, username, created_at)
      SELECT ?, ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM telegram_registrations WHERE id_hash = ? AND status = 'pending' AND expires_at > ? AND telegram_user_id IS NULL
      ) ON CONFLICT(telegram_user_id) DO NOTHING`).bind(telegramId, firstName, username, now, registrationHash, now),
    env.DB.prepare(`UPDATE telegram_registrations SET status = 'complete', telegram_user_id = ?,
      student_id = (SELECT id FROM students WHERE telegram_user_id = ?), completed_at = ?
      WHERE id_hash = ? AND status = 'pending' AND expires_at > ? AND telegram_user_id IS NULL
      AND EXISTS (SELECT 1 FROM students WHERE telegram_user_id = ?)`).bind(telegramId, telegramId, now, registrationHash, now, telegramId)
  ]);
  const completed = await env.DB.prepare("SELECT status FROM telegram_registrations WHERE id_hash = ? AND telegram_user_id = ?")
    .bind(registrationHash, telegramId).first();
  if (!completed || completed.status !== "complete") {
    await sendBotMessage(env, chatId, "Не удалось подтвердить эту заявку. Откройте новую ссылку регистрации на сайте.");
    return;
  }
  await sendBotMessage(env, chatId, "Telegram подтверждён. Аккаунт ученика создан — вернитесь на сайт.");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") return new Response(null, {status:204,headers:cors});
    if (url.pathname === "/health") return responseJson({ok:true,service:"telegram-login"});
    if (url.pathname === "/register/telegram/start" && request.method === "POST") {
      if (origin !== env.FRONTEND_URL) return responseJson({error:"Origin not allowed"},403,cors);
      if (!env.DB || !env.BOT_USERNAME || !env.SESSION_SECRET) return responseJson({error:"Registration service is not configured"},503,cors);
      const registrationId = randomToken();
      const pollSecret = randomToken();
      const now = new Date();
      const expires = new Date(now.getTime() + 10 * 60 * 1000);
      await env.DB.prepare(`DELETE FROM telegram_registrations WHERE
        (status = 'pending' AND expires_at <= ?) OR (status = 'complete' AND completed_at <= ?)`)
        .bind(now.toISOString(), new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()).run();
      await env.DB.prepare(`INSERT INTO telegram_registrations (id_hash, poll_hash, status, created_at, expires_at)
        VALUES (?, ?, 'pending', ?, ?)`).bind(await sha256(registrationId), await sha256(pollSecret), now.toISOString(), expires.toISOString()).run();
      return responseJson({url:`https://t.me/${env.BOT_USERNAME}?start=${registrationId}`,id:registrationId,pollSecret,expiresAt:expires.toISOString()},200,cors);
    }
    if (url.pathname === "/register/telegram/status" && request.method === "POST") {
      if (origin !== env.FRONTEND_URL) return responseJson({error:"Origin not allowed"},403,cors);
      if (!env.DB || !env.SESSION_SECRET) return responseJson({error:"Registration service is not configured"},503,cors);
      let body;
      try { body = await request.json(); } catch { return responseJson({error:"Invalid request"},400,cors); }
      if (!/^[A-Za-z0-9_-]{40,60}$/.test(body.id || "") || !/^[A-Za-z0-9_-]{40,60}$/.test(body.pollSecret || "")) return responseJson({error:"Invalid registration"},400,cors);
      const record = await env.DB.prepare(`SELECT r.status, r.expires_at, s.telegram_user_id, s.first_name, s.username
        FROM telegram_registrations r LEFT JOIN students s ON s.id = r.student_id WHERE r.id_hash = ? AND r.poll_hash = ?`)
        .bind(await sha256(body.id), await sha256(body.pollSecret)).first();
      if (!record || (record.status === "pending" && Date.parse(record.expires_at) <= Date.now())) return responseJson({status:"expired"},410,cors);
      if (record.status !== "complete" || !record.telegram_user_id) return responseJson({status:"pending"},200,cors);
      const session = await signValue({sub:record.telegram_user_id,name:record.first_name || "",username:record.username || "",picture:"",exp:Date.now()+7*24*60*60*1000},env.SESSION_SECRET);
      return responseJson({status:"complete",session,user:{id:record.telegram_user_id,name:record.first_name || "",username:record.username || ""}},200,cors);
    }
    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      if (!env.DB || !env.BOT_TOKEN || !env.WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return responseJson({error:"Unauthorized"},401);
      let update;
      try { update = await request.json(); } catch { return responseJson({error:"Invalid update"},400); }
      await completeTelegramRegistration(update,env);
      return responseJson({ok:true});
    }
    if (url.pathname === "/auth/login") {
      if (!env.CLIENT_ID || !env.CLIENT_SECRET || !env.SESSION_SECRET || !env.FRONTEND_URL) return responseJson({error:"Server configuration is incomplete"},500);
      const state = b64url(crypto.getRandomValues(new Uint8Array(32)));
      const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
      const stateCookie = await signValue({state,verifier,exp:Date.now()+10*60*1000}, env.SESSION_SECRET);
      const redirectUri = url.origin + "/auth/callback";
      const auth = new URL("https://oauth.telegram.org/auth");
      auth.search = new URLSearchParams({client_id:env.CLIENT_ID,redirect_uri:redirectUri,response_type:"code",scope:"openid profile",state,code_challenge:challenge,code_challenge_method:"S256"}).toString();
      return new Response(null,{status:302,headers:{Location:auth.toString(),"Set-Cookie":setCookie(stateCookie,600)}});
    }
    if (url.pathname === "/auth/callback") {
      const saved = await verifyValue(cookie(request,"oidc_state"), env.SESSION_SECRET || "");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!saved || saved.exp < Date.now() || !state || state !== saved.state || !code) {
        return new Response("Telegram login could not be verified. Please try again.",{status:400,headers:{"Set-Cookie":clearCookie()}});
      }
      const redirectUri = url.origin + "/auth/callback";
      const basic = btoa(env.CLIENT_ID+":"+env.CLIENT_SECRET);
      const tokenResponse = await fetch("https://oauth.telegram.org/token",{
        method:"POST",
        headers:{"Content-Type":"application/x-www-form-urlencoded","Authorization":"Basic "+basic},
        body:new URLSearchParams({grant_type:"authorization_code",code,redirect_uri:redirectUri,client_id:env.CLIENT_ID,code_verifier:saved.verifier})
      });
      if (!tokenResponse.ok) return new Response("Telegram token exchange failed. Please try again.",{status:502,headers:{"Set-Cookie":clearCookie()}});
      const tokenData = await tokenResponse.json();
      try {
        const claims = await verifyTelegramIdToken(tokenData.id_token,env);
        const session = await signValue({sub:String(claims.sub),name:claims.name || "",username:claims.preferred_username || "",picture:claims.picture || "",exp:Date.now()+7*24*60*60*1000},env.SESSION_SECRET);
        return new Response(null,{status:302,headers:{Location:(env.FRONTEND_URL.endsWith("/") ? env.FRONTEND_URL.slice(0,-1) : env.FRONTEND_URL)+"/#session="+encodeURIComponent(session),"Set-Cookie":clearCookie(),"Cache-Control":"no-store"}});
      } catch {
        return new Response("Telegram identity could not be verified. Please try again.",{status:401,headers:{"Set-Cookie":clearCookie()}});
      }
    }
    if (url.pathname === "/auth/me") {
      if (origin !== env.FRONTEND_URL) return responseJson({error:"Origin not allowed"},403,cors);
      const auth = request.headers.get("Authorization") || "";
      const session = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const user = await verifyValue(session,env.SESSION_SECRET || "");
      if (!user || user.exp < Date.now()) return responseJson({authenticated:false},401,cors);
      return responseJson({authenticated:true,user:{id:user.sub,name:user.name,username:user.username,picture:user.picture}},200,{...Object.fromEntries(cors)});
    }
    if (url.pathname === "/auth/logout") return responseJson({ok:true},200,cors);
    return responseJson({error:"Not found"},404,cors);
  }
};

