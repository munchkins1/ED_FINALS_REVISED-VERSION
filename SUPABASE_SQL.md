# Supabase SQL — Educational Level fields

Copy **everything inside the code block below** and paste it into the
Supabase **SQL Editor**, then press **Run**.

**Already running `sql/01_schema.sql`?** Re-run that file instead — as of now it
contains this exact migration (`ALTER TABLE … IF NOT EXISTS`, backfill and
grants), so `01` alone upgrades an existing database. This document is the
standalone equivalent.

**Fresh install:** run `sql/01_schema.sql` … `sql/08_admin_delete_user.sql` in
order; `10` and this file are then optional.

> Mirrors `sql/01_schema.sql` and `sql/10_education_levels.sql`. If you change
> one, change the others.

---

## ⚠️ Why this must run before anyone registers

The signup trigger (`handle_new_user`) now writes into
`educational_level`, `course`, `year_level`, `block`, `section` and `phone`.
Until the columns below exist:

- the **Profile tab shows "Not set"** for Education Level / Information, and
- re-running `sql/01`, `sql/07` or `sql/09` makes **every new signup fail** with
  `column "educational_level" of relation "profiles" does not exist`.

**Take a backup first:** Dashboard → `Database` → `Backups` → `Create backup`.

---

## The SQL

```sql
-- ============================================================
-- Educational Level / Course / Year / Block / Section / Phone
-- Safe to re-run. Run this LAST, after 01-08.
-- ============================================================

-- ---------- enum (safe to re-run) ----------
do $$ begin
  create type public.educational_level as enum
    ('college', 'senior_high', 'junior_high', 'elementary');
exception when duplicate_object then null; end $$;


-- ---------- new columns ----------
-- `section` and `block` are non-reserved keywords in PostgreSQL.
alter table public.profiles add column if not exists educational_level public.educational_level;
alter table public.profiles add column if not exists course     text;
alter table public.profiles add column if not exists year_level text;
alter table public.profiles add column if not exists block      text;
alter table public.profiles add column if not exists section    text;

comment on column public.profiles.educational_level is 'college | senior_high | junior_high | elementary';
comment on column public.profiles.course           is 'College course (BSIT, ...) or SHS track (STEM, ...)';
comment on column public.profiles.year_level       is 'College year 1-4, or grade level 11-12 / 7-10 / 1-6';
comment on column public.profiles.block            is 'College block A-F; NULL for every other level';
comment on column public.profiles.section          is 'Free-text section for SHS / JHS / Elementary; NULL for College';
comment on column public.profiles.grade_class      is 'Denormalised display string built by formatGradeClass(); kept for reports.';


-- ---------- safe enum cast ----------
-- Reads educational_level from client-supplied auth metadata, so a hand-crafted
-- signUp with a bogus value must not abort the INSERT.
create or replace function public.try_education_level(value text)
returns public.educational_level
language plpgsql
immutable
as $$
begin
  return nullif(value, '')::public.educational_level;
exception when others then
  return null;
end;
$$;


-- ---------- backfill: infer the level of existing rows ----------
-- Legacy rows stored "College Department" / "Senior High" / "Junior High" /
-- "Kindergarten" in `department`, and "Grade 11-A" in `grade_class`.
with legacy as (
  select
    p.id,
    case
      when p.department ilike '%college%' then 'college'::public.educational_level
      when p.department ilike '%senior%'  then 'senior_high'::public.educational_level
      when p.department ilike '%junior%'  then 'junior_high'::public.educational_level
      when p.department ilike '%kinder%'  then 'elementary'::public.educational_level
      when g.n between 1  and 6            then 'elementary'::public.educational_level
      when g.n between 7  and 10           then 'junior_high'::public.educational_level
      when g.n between 11 and 12           then 'senior_high'::public.educational_level
    end as lvl
  from public.profiles p
  left join lateral (
    -- "Grade 11-A" -> 11. NULL when the string does not start with a grade.
    select nullif((regexp_match(coalesce(p.grade_class, ''), '^grade\s+(\d+)'))[1], '')::int as n
  ) g on true
)
update public.profiles p
   set educational_level = l.lvl
  from legacy l
 where p.id = l.id
   and p.educational_level is null
   and l.lvl is not null;


-- ---------- harden the signup trigger ----------
-- Also copies `phone`, which the old trigger never did. The copies in
-- 01_schema.sql, 07_security_hardening.sql and 09_registration_student_no.sql
-- must stay byte-identical to this one.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id, email, full_name, role, student_no, phone,
    educational_level, course, year_level, block, section,
    department, grade_class
  )
  values (
    new.id,
    new.email,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      split_part(new.email, '@', 1)
    ),
    'student',  -- public signups are ALWAYS students, whatever metadata claims
    nullif(new.raw_user_meta_data ->> 'student_no', ''),
    nullif(new.raw_user_meta_data ->> 'phone', ''),
    -- from the registration "Educational Level" dropdown
    public.try_education_level(new.raw_user_meta_data ->> 'educational_level'),
    nullif(new.raw_user_meta_data ->> 'course', ''),
    nullif(new.raw_user_meta_data ->> 'year_level', ''),
    nullif(new.raw_user_meta_data ->> 'block', ''),
    nullif(new.raw_user_meta_data ->> 'section', ''),
    -- legacy free-text pair, still used by the admin reports
    nullif(new.raw_user_meta_data ->> 'department', ''),
    nullif(new.raw_user_meta_data ->> 'grade_class', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ---------- column-level privileges ----------
-- Eleven self-editable columns. Any column missing from this list fails with
-- "permission denied for table profiles" the moment a profile is saved.
revoke update on public.profiles from anon, authenticated;

grant update (full_name, phone, student_no, grade_class, department, title,
              educational_level, course, year_level, block, section)
  on public.profiles to authenticated;
```

---

## Verify it worked

Run each of these as a **separate** query. All are read-only.

**1. The five columns exist**

```sql
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'profiles'
   and column_name in ('educational_level','course','year_level','block','section')
 order by column_name;
```

Expected — `educational_level` is `USER-DEFINED` (the enum), the rest `text`:

| column_name | data_type |
|---|---|
| block | text |
| course | text |
| educational_level | USER-DEFINED |
| section | text |
| year_level | text |

**2. Students can edit exactly 11 columns — never `role` or `is_active`**

```sql
select column_name
  from information_schema.column_privileges
 where table_schema = 'public' and table_name = 'profiles'
   and grantee = 'authenticated' and privilege_type = 'UPDATE'
 order by column_name;
```

Expected 11 rows: `block, course, department, educational_level, full_name,
grade_class, phone, section, student_no, title, year_level`.
Must **not** contain `role`, `is_active`, `email`, `id`, `created_at`.

**3. Existing accounts got classified by the backfill**

```sql
select educational_level, count(*) from public.profiles group by 1 order by 1;
```

Expected: `NULL` only for rows that had neither a recognisable `department`
nor a `Grade N` string.

**4. The safe cast swallows bad input instead of breaking signup**

```sql
select public.try_education_level('college');      -- college
select public.try_education_level('superuser');    -- NULL, no error
```

---

## After running it

1. **Hard-refresh** the browser — `Ctrl+Shift+R` (Windows) or `Cmd+Shift+R` (Mac).
   The Profile tab caches `app.html`, so a normal refresh may still show the old markup.
2. Open **Profile** → you should see an **Education Level / Information** section
   with *Educational Level* first, followed by Course / Year / Block / Section
   for whichever level is set.
3. If it still says **"Not set"** with an amber warning, your account predates the
   migration or an admin has not filled it in — go to
   **Admin → Manage Users → Edit** and choose the Educational Level.
4. Register one test account per level and confirm the Profile tab matches the
   registration form exactly (password is never shown, by design).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `permission denied for table profiles` on save | The `grant update` did not run. Re-run this file. |
| `column "educational_level" does not exist` at signup | You ran `sql/01`, `07` or `09` before this. Run this file again. |
| Profile still shows the old layout | Hard-refresh to bust the `app.html` cache. |
| An old account shows the wrong level | Set it in **Admin → Manage Users → Edit**; the backfill only infers what it can. |


