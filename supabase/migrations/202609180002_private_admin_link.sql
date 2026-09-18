-- Private admin links are checked by Edge Functions, never by browser UI alone.
-- Only the server's service_role can call these write functions.
create or replace function public.save_order(ticket_keys text[], expected_revision bigint) returns bigint
language plpgsql security definer set search_path = '' as $$
declare current_revision bigint;
begin
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

create or replace function public.set_pr_links(issue_key text, urls text[], expected_revision bigint) returns bigint
language plpgsql security definer set search_path = '' as $$
declare current_revision bigint;
begin
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

revoke all on function public.save_order(text[], bigint) from public, anon, authenticated;
revoke all on function public.set_pr_links(text, text[], bigint) from public, anon, authenticated;
grant execute on function public.save_order(text[], bigint) to service_role;
grant execute on function public.set_pr_links(text, text[], bigint) to service_role;
grant execute on function public.get_queue() to service_role;
grant select on public.review_tickets, public.queue_state to service_role;
drop table public.queue_admins;
