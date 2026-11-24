begin;

-- Keep these tables inaccessible to browser roles. Edge Function requests use service_role.
alter table public.admins enable row level security;
alter table public.student_access enable row level security;
alter table public.lessons enable row level security;

revoke all on table public.students, public.telegram_registration_challenges, public.admins, public.student_access, public.lessons from public, anon, authenticated;
grant usage on schema public to service_role;
grant select, insert, update, delete on table public.students, public.telegram_registration_challenges, public.admins, public.student_access, public.lessons to service_role;

create index if not exists lessons_starts_at_idx on public.lessons (starts_at);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'student_access_telegram_id_fkey'
      and conrelid = 'public.student_access'::regclass
  ) then
    alter table public.student_access
      add constraint student_access_telegram_id_fkey
      foreign key (telegram_id) references public.students (telegram_user_id)
      on update cascade on delete cascade;
  end if;
end;
$$;

do $$
declare
  lesson_id_sequence text := pg_get_serial_sequence('public.lessons', 'id');
begin
  if lesson_id_sequence is not null then
    execute format('grant usage, select on sequence %s to service_role', lesson_id_sequence);
  end if;
end;
$$;

commit;

