-- Only minimal, intentionally public ticket data belongs in these tables.
create table public.review_tickets (
  ticket_key text primary key check (ticket_key ~ '^SP-[0-9]+$'),
  short_title text not null check (length(short_title) <= 100),
  jira_url text not null check (jira_url ~ '^https://sharinpix[.]atlassian[.]net/browse/SP-[0-9]+$'),
  pr_urls text[] not null default '{}',
  manual_pr_urls text[],
  position bigint not null
);

create table public.queue_state (
  id boolean primary key default true check (id),
  revision bigint not null default 0,
  last_synced_at timestamptz,
  order_updated_at timestamptz
);
insert into public.queue_state (id) values (true);

create table public.queue_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

alter table public.review_tickets enable row level security;
alter table public.queue_state enable row level security;
alter table public.queue_admins enable row level security;

revoke all on public.review_tickets, public.queue_state, public.queue_admins from anon, authenticated;
grant select on public.review_tickets, public.queue_state to anon, authenticated;
grant select on public.queue_admins to authenticated;
create policy public_ticket_read on public.review_tickets for select to anon, authenticated using (true);
create policy public_state_read on public.queue_state for select to anon, authenticated using (true);
create policy own_admin_read on public.queue_admins for select to authenticated using (user_id = (select auth.uid()));

-- A single JSON snapshot prevents a sync between separate state/ticket reads.
create function public.get_queue() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'revision', s.revision,
    'last_synced_at', s.last_synced_at,
    'order_updated_at', s.order_updated_at,
    'tickets', coalesce((select jsonb_agg(jsonb_build_object(
      'ticket_key', t.ticket_key, 'short_title', t.short_title,
      'jira_url', t.jira_url, 'pr_urls', coalesce(t.manual_pr_urls, t.pr_urls),
      'position', t.position) order by t.position, t.ticket_key)
      from public.review_tickets t), '[]'::jsonb)
  ) from public.queue_state s where s.id;
$$;

create function public.save_order(ticket_keys text[], expected_revision bigint) returns bigint
language plpgsql security definer set search_path = '' as $$
declare current_revision bigint;
begin
  if not exists (select 1 from public.queue_admins where user_id = auth.uid()) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  select revision into current_revision from public.queue_state where id for update;
  if expected_revision is distinct from current_revision then
    raise exception 'Queue changed. Reload before saving.' using errcode = '40001';
  end if;
  if ticket_keys is null or exists (select 1 from unnest(ticket_keys) k where k is null)
    or cardinality(ticket_keys) <> (select count(distinct k) from unnest(ticket_keys) k)
    or cardinality(ticket_keys) <> (select count(*) from public.review_tickets)
    or exists (select 1 from unnest(ticket_keys) k where not exists
      (select 1 from public.review_tickets t where t.ticket_key = k)) then
    raise exception 'Order must include every current ticket exactly once';
  end if;
  update public.review_tickets t set position = ordered.n
    from unnest(ticket_keys) with ordinality as ordered(k, n) where t.ticket_key = ordered.k;
  update public.queue_state set revision = revision + 1, order_updated_at = now() where id
    returning revision into current_revision;
  return current_revision;
end;
$$;

create function public.set_pr_links(issue_key text, urls text[], expected_revision bigint) returns bigint
language plpgsql security definer set search_path = '' as $$
declare current_revision bigint;
begin
  if not exists (select 1 from public.queue_admins where user_id = auth.uid()) then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  select revision into current_revision from public.queue_state where id for update;
  if expected_revision is distinct from current_revision then
    raise exception 'Queue changed. Reload before saving.' using errcode = '40001';
  end if;
  if cardinality(urls) > 20 or exists (select 1 from unnest(urls) u
    where u is null or u !~ '^https://github[.]com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+$') then
    raise exception 'Use GitHub pull request URLs';
  end if;
  update public.review_tickets set manual_pr_urls = urls where ticket_key = issue_key;
  if not found then raise exception 'Ticket is no longer in review'; end if;
  update public.queue_state set revision = revision + 1 where id returning revision into current_revision;
  return current_revision;
end;
$$;

-- Called only by the Edge Function's service key. An incomplete fetch must never call this.
create function public.sync_review_queue(items jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare item jsonb; next_position bigint; links text[];
begin
  if jsonb_typeof(items) is distinct from 'array' then raise exception 'Expected ticket array'; end if;
  perform 1 from public.queue_state where id for update;
  if (select count(*) from jsonb_array_elements(items)) <>
     (select count(distinct value->>'ticket_key') from jsonb_array_elements(items)) then
    raise exception 'Duplicate or missing ticket keys';
  end if;
  select coalesce(max(position), 0) into next_position from public.review_tickets;
  for item in select value from jsonb_array_elements(items) loop
    links := null;
    if item ? 'pr_urls' and item->'pr_urls' <> 'null'::jsonb then
      select coalesce(array_agg(value), '{}'::text[]) into links from jsonb_array_elements_text(item->'pr_urls');
      if cardinality(links) > 20 or exists (select 1 from unnest(links) u where u is null or
          u !~ '^https://github[.]com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+$') then
        raise exception 'Invalid PR link';
      end if;
    end if;
    next_position := next_position + 1;
    insert into public.review_tickets(ticket_key, short_title, jira_url, pr_urls, position)
    values (item->>'ticket_key', item->>'short_title', item->>'jira_url', coalesce(links, '{}'), next_position)
    on conflict(ticket_key) do update set short_title = excluded.short_title, jira_url = excluded.jira_url,
      pr_urls = coalesce(links, public.review_tickets.pr_urls);
  end loop;
  delete from public.review_tickets where ticket_key not in
    (select value->>'ticket_key' from jsonb_array_elements(items));
  update public.queue_state set revision = revision + 1, last_synced_at = now() where id;
end;
$$;

revoke all on function public.get_queue() from public, anon, authenticated;
revoke all on function public.save_order(text[], bigint) from public, anon, authenticated;
revoke all on function public.set_pr_links(text, text[], bigint) from public, anon, authenticated;
revoke all on function public.sync_review_queue(jsonb) from public, anon, authenticated;
grant execute on function public.get_queue() to anon, authenticated;
grant execute on function public.save_order(text[], bigint) to authenticated;
grant execute on function public.set_pr_links(text, text[], bigint) to authenticated;
grant execute on function public.sync_review_queue(jsonb) to service_role;

-- A lease prevents manual and scheduled syncs from racing. Never exposed to visitors.
create table public.sync_lock (
  id boolean primary key default true check (id),
  lease uuid,
  expires_at timestamptz not null default '-infinity'
);
insert into public.sync_lock(id) values (true);
alter table public.sync_lock enable row level security;
revoke all on public.sync_lock from anon, authenticated;
grant select on public.queue_admins to service_role;
-- service_role bypasses RLS on hosted Supabase.
create function public.claim_sync() returns uuid
language plpgsql security definer set search_path = '' as $$
declare token uuid;
begin
  update public.sync_lock set lease = gen_random_uuid(), expires_at = now() + interval '10 minutes'
    where id and expires_at < now() returning lease into token;
  return token;
end;
$$;
create function public.release_sync(lease uuid) returns void
language sql security definer set search_path = '' as $$
  update public.sync_lock set expires_at = '-infinity' where id and sync_lock.lease = release_sync.lease;
$$;
revoke all on function public.claim_sync() from public, anon, authenticated;
revoke all on function public.release_sync(uuid) from public, anon, authenticated;
grant execute on function public.claim_sync() to service_role;
grant execute on function public.release_sync(uuid) to service_role;
