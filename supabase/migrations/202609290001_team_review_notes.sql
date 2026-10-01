-- Team links and review context are intentionally editable by anyone with the page.
-- Ordering, ticket membership and Jira sync remain server-only operations.
alter table public.review_tickets
  add column urgency text not null default 'normal' check (urgency in ('normal', 'important', 'urgent')),
  add column client_waiting boolean not null default false,
  add column review_note text not null default '' check (length(review_note) <= 500);

create or replace function public.get_queue() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'revision', s.revision,
    'last_synced_at', s.last_synced_at,
    'order_updated_at', s.order_updated_at,
    'tickets', coalesce((select jsonb_agg(jsonb_build_object(
      'ticket_key', t.ticket_key, 'short_title', t.short_title,
      'jira_url', t.jira_url, 'pr_urls', coalesce(t.manual_pr_urls, t.pr_urls),
      'urgency', t.urgency, 'client_waiting', t.client_waiting, 'review_note', t.review_note,
      'position', t.position) order by t.position, t.ticket_key)
      from public.review_tickets t), '[]'::jsonb)
  ) from public.queue_state s where s.id;
$$;

-- The existing function validates GitHub URLs, locks the revision and only edits links.
grant execute on function public.set_pr_links(text, text[], bigint) to anon, authenticated;

create function public.set_review_context(issue_key text, urgency text, client_waiting boolean, review_note text, expected_revision bigint) returns bigint
language plpgsql security definer set search_path = '' as $$
declare current_revision bigint;
begin
  select revision into current_revision from public.queue_state where id for update;
  if expected_revision is distinct from current_revision then
    raise exception 'Queue changed. Reload before saving.' using errcode = '40001';
  end if;
  if urgency is null or urgency not in ('normal', 'important', 'urgent')
    or client_waiting is null or review_note is null or length(review_note) > 500 then
    raise exception 'Choose a valid urgency and a note of up to 500 characters' using errcode = '22023';
  end if;
  update public.review_tickets t set
    urgency = set_review_context.urgency,
    client_waiting = set_review_context.client_waiting,
    review_note = btrim(set_review_context.review_note)
    where t.ticket_key = issue_key;
  if not found then raise exception 'Ticket is no longer in review'; end if;
  update public.queue_state set revision = revision + 1 where id returning revision into current_revision;
  return current_revision;
end;
$$;

revoke all on function public.set_review_context(text, text, boolean, text, bigint) from public, anon, authenticated;
grant execute on function public.set_review_context(text, text, boolean, text, bigint) to anon, authenticated, service_role;
