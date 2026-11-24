# Регистрация учеников через Telegram и Supabase

Сайт остаётся на GitHub Pages. Supabase Edge Function принимает webhook Telegram, выдаёт одноразовый код и после его проверки создаёт запись в таблице `students`. Cloudflare Worker для этой регистрации не используется.

## Сценарий ученика

1. На сайте открыть **Курсы → Мои курсы** и нажать **Зарегистрироваться через Telegram**.
2. Перейти в `@OnlineSchoolOgBot` по ссылке на сайте и нажать **Запустить**. Telegram не позволяет боту первым написать пользователю по одному только `@username`.
3. Получить шестизначный код в личном чате с ботом, ввести его на сайте. Код действует 5 минут; после 5 неверных попыток заявка блокируется.
4. После проверки Supabase создаёт или находит запись ученика по Telegram ID. Код в базе хранится только в виде HMAC-хеша.

## Подготовка Supabase

Нужен Supabase project. Выполнить миграцию `supabase/migrations/0001_telegram_student_registration.sql` через SQL Editor в Supabase Dashboard. Затем подключить каталог репозитория к проекту и развернуть функцию:

```powershell
npx supabase login
npx supabase link --project-ref <PROJECT_REF>
npx supabase functions deploy telegram-registration
```

Добавить в Supabase → Edge Functions → Secrets:

- `TELEGRAM_BOT_TOKEN` — токен `@OnlineSchoolOgBot` из BotFather.
- `TELEGRAM_WEBHOOK_SECRET` — случайная строка только из букв, цифр, `_` и `-`, минимум 32 символа.
- `TELEGRAM_CODE_PEPPER` — отдельный случайный секрет минимум 32 байта.
- `TELEGRAM_BOT_USERNAME` — `OnlineSchoolOgBot`.

Supabase предоставляет Edge Function URL и секретный ключ для server-side запросов. Они используются только в функции; ключ обхода RLS нельзя помещать в сайт или GitHub.

Развернуть функцию `telegram-registration`, затем установить Telegram webhook на:

```text
https://<PROJECT_REF>.supabase.co/functions/v1/telegram-registration
```

При установке webhook передать `secret_token` равный `TELEGRAM_WEBHOOK_SECRET`. В webhook для Telegram должна быть включена передача `message` updates.

## Подключение GitHub Pages

В `index.html` заменить значения `YOUR_PROJECT_REF` и `YOUR_SUPABASE_PUBLISHABLE_KEY` в константах `SUPABASE_URL` и `SUPABASE_PUBLISHABLE_KEY`. Publishable key можно помещать в браузер; secret/service-role key — нельзя. `supabase/config.toml` отключает стандартную JWT-проверку только для этой функции: вызов webhook проверяет отдельный секрет Telegram, а публичные действия ограничены созданием заявки и проверкой кода.

После публикации через существующий workflow GitHub Pages кнопка появится в разделе «Мои курсы». Проверить регистрацию тестовым Telegram-аккаунтом: код должен прийти от бота, а в `students` должна появиться одна строка с Telegram ID.

## Данные и доступ

Таблица `students` содержит Telegram ID, username (если он установлен), имя и дату создания записи. Таблицы закрыты RLS без публичных политик. Код подтверждения ограничен сроком действия и числом попыток; создание записи ученика и пометка заявки как завершённой выполняются одной SQL-функцией.

