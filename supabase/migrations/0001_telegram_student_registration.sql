create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id text not null unique,
  telegram_username text,
  first_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.telegram_registration_challenges (
  id text primary key,
  status text not null check (status in ('pending', 'code_sent', 'complete', 'expired', 'locked')),
  telegram_user_id text,
  telegram_username text,
  first_name text,
  code_hash text,
  attempts integer not null default 0 check (attempts >= 0 and attempts <= 5),
  student_id uuid references public.students(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  code_expires_at timestamptz,
  completed_at timestamptz
);

create index if not exists telegram_registration_expiry_idx
  on public.telegram_registration_challenges (expires_at);

alter table public.students enable row level security;
alter table public.telegram_registration_challenges enable row level security;

create or replace function public.verify_telegram_registration(
  p_registration_id text,
  p_code_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_registration public.telegram_registration_challenges%rowtype;
  v_student public.students%rowtype;
begin
  select * into v_registration
    from public.telegram_registration_challenges
    where id = p_registration_id
    for update;

  if not found then
    return jsonb_build_object('status', 'expired');
  end if;

  if v_registration.status = 'complete' then
    return jsonb_build_object('status', 'complete', 'student_id', v_registration.student_id, 'name', v_registration.first_name);
  end if;

  if v_registration.status <> 'code_sent' or v_registration.expires_at <= now()
     or v_registration.code_expires_at is null or v_registration.code_expires_at <= now() then
    update public.telegram_registration_challenges
      set status = 'expired', code_hash = null
      where id = p_registration_id and status in ('pending', 'code_sent');
    return jsonb_build_object('status', 'expired');
  end if;

  if v_registration.attempts >= 5 or v_registration.status = 'locked' then
    update public.telegram_registration_challenges set status = 'locked', code_hash = null where id = p_registration_id;
    return jsonb_build_object('status', 'locked');
  end if;

  if v_registration.code_hash is distinct from p_code_hash then
    update public.telegram_registration_challenges
      set attempts = attempts + 1,
          status = case when attempts + 1 >= 5 then 'locked' else status end,
          code_hash = case when attempts + 1 >= 5 then null else code_hash end
      where id = p_registration_id;
    return jsonb_build_object('status', case when v_registration.attempts + 1 >= 5 then 'locked' else 'wrong_code' end);
  end if;

  insert into public.students (telegram_user_id, telegram_username, first_name)
    values (v_registration.telegram_user_id, v_registration.telegram_username, coalesce(v_registration.first_name, 'Ученик'))
    on conflict (telegram_user_id) do update
      set telegram_username = excluded.telegram_username,
          first_name = excluded.first_name
    returning * into v_student;

  update public.telegram_registration_challenges
    set status = 'complete', student_id = v_student.id, code_hash = null, completed_at = now()
    where id = p_registration_id;

  return jsonb_build_object('status', 'complete', 'student_id', v_student.id, 'name', v_student.first_name);
end;
$$;

revoke all on function public.verify_telegram_registration(text, text) from public, anon, authenticated;
grant execute on function public.verify_telegram_registration(text, text) to service_role;

