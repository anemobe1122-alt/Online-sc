# Telegram-регистрация, расписание и администрирование

Сайт публикуется на GitHub Pages. Функция Supabase `rapid-worker` одновременно принимает Telegram webhook и обрабатывает регистрацию, серверные сессии, расписание и административные действия. Отдельная Cloudflare Worker в `worker/` не участвует в этом потоке.

## Регистрация и сессия

1. Ученик начинает регистрацию на сайте и открывает персональную ссылку на `@OnlineSchoolOgBot`.
2. Бот получает числовой Telegram ID из `message.from.id`, отправляет шестизначный код в личный чат.
3. После проверки кода через `verify_telegram_registration` функция выдаёт подписанную на сервере сессию сроком на 12 часов. Браузер передаёт её как Bearer-токен; сервер проверяет подпись, срок действия и соответствие ID записи `students` при каждом запросе.

## База данных и Edge Function

Миграции:

- `supabase/migrations/0001_telegram_student_registration.sql` — таблицы регистрации, `students` и закрытая SQL-функция проверки кода.
- `supabase/migrations/0002_schedule_admin_access.sql` — закрытые права для браузерных ролей, доступ только сервисной роли, связь доступа с зарегистрированным учеником и индекс расписания.

Для развёртывания из репозитория:

```powershell
npx supabase login
npx supabase link --project-ref <PROJECT_REF>
npx supabase db push
npx supabase functions deploy rapid-worker
```

У функции оставлена `verify_jwt = false`: она самостоятельно проверяет Telegram webhook secret и подписанную сессию для защищённых запросов. Не меняйте настроенный Telegram webhook и его секрет при обычном обновлении кода.

Существующие Edge Function secrets остаются серверными: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_CODE_PEPPER`, `TELEGRAM_BOT_USERNAME`. Новые секреты не нужны: `TELEGRAM_CODE_PEPPER` используется также для HMAC-подписи сессии. Ни один из этих секретов нельзя помещать в HTML или GitHub.

## Администрирование и доступ учеников

- Администратор определяется только записью в `admins.telegram_id`, совпадающей с ID подтверждённого Telegram-пользователя.
- Ученик получает расписание только при `student_access.is_active = true` для его числового `telegram_id`.
- Администратор может создавать, редактировать и удалять занятия в `lessons`, просматривать зарегистрированных учеников и выдавать или отзывать доступ.
- Все эти операции проходят через `rapid-worker`; SQL-таблицы не имеют публичных RLS-политик или прав записи для `anon` и `authenticated`.

Первая административная запись должна быть добавлена доверенным владельцем в `admins.telegram_id` после регистрации этого Telegram-аккаунта. Сейчас в проекте уже есть одна такая запись.

## GitHub Pages

Публичный Supabase URL и publishable key находятся в `index.html`; они не дают права обходить RLS. Секретный ключ Supabase и токен бота остаются только в Edge Function secrets. Сайт использует существующий адрес `https://xjxwsapkrrvqrorovxfb.supabase.co/functions/v1/rapid-worker`.

