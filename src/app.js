import { createClient } from '@supabase/supabase-js';
import './style.css';

const $ = (s) => document.querySelector(s);
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const demo = new URLSearchParams(location.search).has('demo');
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const configured = url?.startsWith('https://') && key && !url.includes('YOUR_PROJECT') && !key.includes('REPLACE_ME');
const client = configured && !demo ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }) : null;
const adminParam = new URLSearchParams(location.search).get('admin');
const adminStorageKey = `review-admin:${url}`;
let adminKey = '';
if (!demo && adminParam) {
  if (adminParam === '1') { try { adminKey = sessionStorage.getItem(adminStorageKey) || ''; } catch {} }
  else if (/^[A-Za-z0-9_-]{32,128}$/.test(adminParam)) {
    adminKey = adminParam;
    try { sessionStorage.setItem(adminStorageKey, adminKey); } catch {}
  }
  // Remove the credential from the address bar immediately; keep only a tab-local session.
  const cleaned = new URL(location.href); cleaned.searchParams.set('admin', '1');
  history.replaceState(null, '', cleaned);
}
let tickets = [], revision = 0, admin = false, dirty = false, busy = false, lastSynced = null, draggedKey = null;
let savedOrder = [];
const demoTickets = [
  ['SP-1001', 'Improve the photo upload experience'],
  ['SP-1002', 'Fix form preview on mobile'],
  ['SP-1003', 'Update document checklist'],
  ['SP-1004', 'Refine album selection'],
].map(([ticket_key, short_title], i) => ({ ticket_key, short_title, position: i + 1, jira_url: '', pr_urls: [], urgency: i === 1 ? 'urgent' : i === 2 ? 'important' : 'normal', client_waiting: i === 1, review_note: i === 1 ? 'Client waiting on this fix. Please review so we can unblock their rollout.' : '' }));

$('#app').innerHTML = `
  <header class="topbar"><div class="brand"><img class="brand-logo" src="./sharinpix-logo.png" alt="SharinPix" width="150" height="66"><span class="brand-divider"></span> <span class="brand-sub">Engineering</span></div><div class="top-actions"><span class="live-dot"></span><span id="view-label">Public view</span><button id="signout" class="button subtle" hidden>Exit admin view</button></div></header>
  <main>
    <div class="eyebrow">SALESFORCE TEAM <span>CODE REVIEW</span></div>
    <section class="heading"><div><h1>Review priorities</h1><p>Your team’s pull requests, in the order that matters.</p></div><button id="share" class="button share-button">Copy team link <span aria-hidden="true">↗</span></button></section>
    <div id="notice" role="status" aria-live="polite" hidden></div>
    <section class="summary" aria-label="Queue overview"><div><span class="summary-label">TICKETS IN REVIEW</span><strong id="count">—</strong></div><div><span class="summary-label">QUEUE ORDER</span><strong class="summary-text" id="order-label">Team priority</strong></div><div><span class="summary-label">LAST JIRA SYNC</span><strong class="summary-text" id="synced">Not synced yet</strong></div></section>
    <div id="attention-summary" class="attention-summary" role="status" hidden></div>
    <section class="queue"><div class="queue-heading"><div><span class="tab-dot"></span><h2>Review queue</h2><span id="badge">0</span></div><button id="reload" class="button subtle">Refresh</button></div>
      <div id="admin-toolbar" hidden><p>Reorder tickets within each list, then save the order for everyone.</p><div><button id="sync" class="button subtle">Sync Jira</button><button id="discard" class="button subtle" disabled>Discard changes</button><button id="save" class="button primary" disabled>Save order</button></div></div>
      <p class="team-help">Anyone with the team link can edit PR links, urgency and review notes.</p>
      <div id="rows" aria-label="Review lists"><div class="empty">Loading the review queue…</div></div>
      <footer class="queue-footer"><span>Start with Focus now, then pick up the remaining reviews.</span><span>Jira · SP / REVIEW</span></footer>
    </section>
    <footer class="page-footer"><span>SharinPix · Salesforce engineering</span><span>Ticket details and code remain in Jira and GitHub.</span></footer>
  </main>
  <dialog id="links-dialog"><form id="links-form"><div class="dialog-heading"><h2 id="links-title">PR links</h2><button type="button" class="button subtle" data-close="links-dialog" aria-label="Close">×</button></div><p>Paste one GitHub pull request URL per line. These links stay saved when Jira refreshes.</p><label>Pull request links<textarea id="pr-input" rows="5" placeholder="https://github.com/team/repo/pull/123"></textarea></label><p id="links-error" role="alert"></p><div class="dialog-actions"><button type="button" id="auto-links" class="button">Use synced links</button><button type="submit" class="button primary">Save links</button></div></form></dialog>
  <dialog id="context-dialog"><form id="context-form">
    <div class="dialog-heading"><h2 id="context-title">Review priority & note</h2><button type="button" class="button subtle" data-close="context-dialog" aria-label="Close">×</button></div>
    <p>Help the team see what needs attention. Changes are visible to everyone with the team link.</p>
    <fieldset class="urgency-options"><legend>Urgency</legend>
      <label><input type="radio" name="urgency" value="normal" checked><span>Normal</span></label>
      <label><input type="radio" name="urgency" value="important"><span>Important</span></label>
      <label><input type="radio" name="urgency" value="urgent"><span>Urgent</span></label>
    </fieldset>
    <label class="checkbox-label"><input type="checkbox" id="client-waiting">Client waiting</label>
    <label>Review note <textarea id="review-note" rows="4" maxlength="500" placeholder="e.g. Client waiting on this fix. Please review before today’s release."></textarea></label>
    <p class="note-help">Up to 500 characters · Public team note</p>
    <p id="context-error" role="alert"></p>
    <div class="dialog-actions"><button type="button" class="button" data-close="context-dialog">Cancel</button><button type="submit" class="button primary">Save priority & note</button></div>
  </form></dialog>
`;

function notice(message, error = false) {
  $('#notice').textContent = message;
  $('#notice').hidden = !message;
  $('#notice').className = error ? 'notice error' : 'notice';
}
function safeLink(href, kind) {
  return kind === 'jira' ? /^https:\/\/sharinpix\.atlassian\.net\/browse\/SP-\d+$/.test(href)
    : /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(href);
}
function urgencyOf(ticket) {
  return ['important', 'urgent'].includes(ticket.urgency) ? ticket.urgency : 'normal';
}
function needsFocus(ticket) {
  return urgencyOf(ticket) !== 'normal' || !!ticket.client_waiting;
}
function renderTicket(t, i, group, focus, offset = 0) {
  return `
    <article class="ticket ${focus && i === 0 ? 'first' : ''} urgency-${urgencyOf(t)} ${t.client_waiting ? 'client-waiting' : ''}" data-key="${escape(t.ticket_key)}" draggable="${admin && !busy}">
      <div class="rank"><span class="drag-handle" aria-hidden="true">${admin ? '⠿' : ''}</span><span>${String(offset + i + 1).padStart(2, '0')}</span></div>
      <div class="ticket-info"><div class="ticket-meta">${safeLink(t.jira_url, 'jira') ? `<a href="${escape(t.jira_url)}" target="_blank" rel="noopener noreferrer">${escape(t.ticket_key)} ↗</a>` : `<span>${escape(t.ticket_key)}</span>`}${focus && i === 0 ? '<span class="next-badge">UP NEXT</span>' : ''}</div><h3>${escape(t.short_title)}</h3>
        <div class="review-flags">${urgencyOf(t) !== 'normal' ? `<span class="urgency-badge ${urgencyOf(t)}">${urgencyOf(t) === 'urgent' ? 'Urgent' : 'Important'}</span>` : ''}${t.client_waiting ? '<span class="waiting-badge">Client waiting</span>' : ''}</div>
        ${t.review_note ? `<div class="review-note"><strong>Review note</strong><p>${escape(t.review_note)}</p></div>` : ''}
        <button class="text-button context-button" data-context="${escape(t.ticket_key)}" ${busy ? 'disabled' : ''}>${t.review_note || urgencyOf(t) !== 'normal' || t.client_waiting ? 'Edit priority & note' : 'Add priority / note'}</button>
      </div>
      <div class="pr-links">${t.pr_urls.filter(u => safeLink(u, 'pr')).map((u, n) => `<a class="pr-link" href="${escape(u)}" target="_blank" rel="noopener noreferrer">PR #${escape(u.split('/').pop())} ↗</a>`).join('') || '<span class="muted">PR link pending</span>'}<button class="text-button" data-links="${escape(t.ticket_key)}" ${busy ? 'disabled' : ''}>${t.pr_urls.length ? 'Edit links' : 'Add PR link'}</button></div>
      <div class="move-controls">${admin ? `<button class="move" data-move="${escape(group[i - 1]?.ticket_key || '')}" data-key="${escape(t.ticket_key)}" aria-label="Move ${escape(t.ticket_key)} up" ${i === 0 || busy ? 'disabled' : ''}>↑</button><button class="move" data-move="${escape(group[i + 1]?.ticket_key || '')}" data-key="${escape(t.ticket_key)}" aria-label="Move ${escape(t.ticket_key)} down" ${i === group.length - 1 || busy ? 'disabled' : ''}>↓</button>` : ''}</div>
    </article>`;
}
const tableHead = '<div class="table-head"><span>ORDER</span><span>TICKET</span><span>PULL REQUESTS</span><span></span></div>';
function render() {
  $('#count').textContent = !lastSynced && !tickets.length && !demo ? '—' : String(tickets.length).padStart(2, '0');
  $('#badge').textContent = tickets.length;
  $('#synced').textContent = demo ? 'Sample data' : lastSynced ? new Date(lastSynced).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not synced yet';
  $('#view-label').textContent = demo ? 'Demo view' : admin ? 'Admin view' : 'Team view';
  const urgent = tickets.filter(t => t.urgency === 'urgent').length;
  const important = tickets.filter(t => t.urgency === 'important').length;
  const waiting = tickets.filter(t => t.client_waiting).length;
  $('#attention-summary').hidden = !urgent && !important && !waiting;
  $('#attention-summary').textContent = `Needs attention · ${urgent} urgent · ${important} important · ${waiting} client waiting`;
  $('#admin-toolbar').hidden = !admin;
  $('#signout').hidden = !admin || demo;
  $('#save').disabled = !dirty || busy;
  $('#discard').disabled = !dirty || busy;
  $('#sync').disabled = dirty || busy || demo;
  $('#order-label').textContent = dirty ? 'Unsaved changes' : 'Focus first';
  const focus = tickets.filter(needsFocus);
  const remaining = tickets.filter(t => !needsFocus(t));
  $('#rows').innerHTML = tickets.length ? `
    <section class="focus-list" aria-labelledby="focus-title">
      <div class="list-heading"><div><span class="list-kicker">PRIORITY LIST</span><h2 id="focus-title">Focus now <span class="list-count">${focus.length}</span></h2><p>Urgent, important, or waiting on us. Start here.</p></div></div>
      ${focus.length ? tableHead + focus.map((t, i) => renderTicket(t, i, focus, true)).join('') : '<div class="focus-empty">No priority reviews flagged. Mark a ticket Important, Urgent, or Client waiting to bring it here.</div>'}
    </section>
    ${remaining.length ? `<section class="remaining-list" aria-labelledby="remaining-title">
      <div class="list-heading"><div><h2 id="remaining-title">Everything else <span class="list-count">${remaining.length}</span></h2><p>No urgency flagged. Pick these up after the focus list.</p></div></div>
      ${tableHead}${remaining.map((t, i) => renderTicket(t, i, remaining, false, focus.length)).join('')}
    </section>` : ''}` : lastSynced
    ? '<div class="empty"><span class="empty-symbol">✓</span><h3>No tickets waiting</h3><p>No tickets were in the review queue at the last successful sync.</p></div>'
    : `<div class="empty"><h3>Jira hasn’t synced yet</h3><p>${admin ? 'Use Sync Jira above to load the review queue.' : 'The queue will appear after the admin syncs Jira. To sync or change priorities, open your private admin link.'}</p></div>`;
}
async function adminCall(action, args = {}) {
  const { data, error } = await client.functions.invoke('admin-queue', {
    headers: { 'x-admin-key': adminKey }, body: { action, ...args },
  });
  if (error) {
    let detail = {};
    if (error.context?.json) { try { detail = await error.context.json(); } catch {} }
    throw Object.assign(new Error(detail.error || 'Admin request failed.'), { code: detail.code });
  }
  return data;
}
async function load() {
  if (!client || dirty || busy || document.querySelector('dialog[open]')) return;
  const { data, error } = await client.rpc('get_queue');
  if (error) { notice('Could not refresh the queue. Check the connection and try again.', true); return; }
  if (dirty || busy || document.querySelector('dialog[open]')) return;
  tickets = data.tickets; revision = data.revision; lastSynced = data.last_synced_at;
  savedOrder = tickets.map(t => t.ticket_key); render();
  if (lastSynced && Date.now() - new Date(lastSynced).getTime() > 45 * 60 * 1000) notice('Jira has not synced recently. This is the last saved queue.');
}
function reorder(from, to) {
  if (!admin || busy || from === to || from < 0 || to < 0 || to >= tickets.length) return;
  if (needsFocus(tickets[from]) !== needsFocus(tickets[to])) {
    notice('To move a ticket between lists, edit its urgency or Client waiting flag.'); return;
  }
  tickets.splice(to, 0, tickets.splice(from, 1)[0]);
  dirty = tickets.some((t, i) => t.ticket_key !== savedOrder[i]); render();
}
$('#rows').addEventListener('click', e => {
  const move = e.target.closest('[data-move]');
  if (move) { const i = tickets.findIndex(t => t.ticket_key === move.dataset.key); reorder(i, tickets.findIndex(t => t.ticket_key === move.dataset.move)); }
  const links = e.target.closest('[data-links]');
  if (links && !busy) {
    if (dirty) { notice('Save or discard your ordering changes before editing PR links.'); return; }
    const ticket = tickets.find(t => t.ticket_key === links.dataset.links);
    $('#links-form').dataset.key = ticket.ticket_key;
    $('#links-form').dataset.revision = revision;
    $('#links-title').textContent = `${ticket.ticket_key} · PR links`;
    $('#pr-input').value = ticket.pr_urls.join('\n'); $('#links-error').textContent = '';
    $('#links-dialog').showModal();
  }
  const context = e.target.closest('[data-context]');
  if (context && !busy) {
    if (dirty) { notice('Save or discard your ordering changes before editing review notes.'); return; }
    const ticket = tickets.find(t => t.ticket_key === context.dataset.context);
    $('#context-form').dataset.key = ticket.ticket_key;
    $('#context-form').dataset.revision = revision;
    $('#context-title').textContent = `${ticket.ticket_key} · Priority & note`;
    $(`#context-form input[value="${urgencyOf(ticket)}"]`).checked = true;
    $('#client-waiting').checked = !!ticket.client_waiting;
    $('#review-note').value = ticket.review_note || '';
    $('#context-error').textContent = '';
    $('#context-dialog').showModal();
  }
});
$('#rows').addEventListener('dragstart', e => {
  if (!admin || busy) { e.preventDefault(); return; }
  draggedKey = e.target.closest('[data-key]')?.dataset.key;
  e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', draggedKey);
});
$('#rows').addEventListener('dragover', e => { if (admin && !busy) e.preventDefault(); });
$('#rows').addEventListener('drop', e => {
  e.preventDefault(); const target = e.target.closest('.ticket')?.dataset.key;
  reorder(tickets.findIndex(t => t.ticket_key === draggedKey), tickets.findIndex(t => t.ticket_key === target));
  draggedKey = null;
});
$('#discard').onclick = async () => {
  tickets.sort((a, b) => savedOrder.indexOf(a.ticket_key) - savedOrder.indexOf(b.ticket_key));
  dirty = false; render(); await load(); notice('Changes discarded.');
};
$('#save').onclick = async () => {
  busy = true; render();
  try {
    if (demo) { savedOrder = tickets.map(t => t.ticket_key); dirty = false; notice('Demo order saved in this preview only.'); }
    else {
      await adminCall('save_order', { ticket_keys: tickets.map(t => t.ticket_key), expected_revision: revision });
      dirty = false; notice('Order saved. Everyone with the team link can see it.');
    }
  } catch (error) { notice(error.code === '40001' ? 'The queue changed while you were editing. Discard changes to load the latest queue, then reorder again.' : 'Could not save. Your changes are still here; check your admin access and retry.', true); }
  finally { busy = false; render(); if (!dirty) await load(); }
};
async function saveTeamEdit(kind, action, args, success) {
  if (busy) return;
  const form = $(`#${kind}-form`);
  const errorBox = $(`#${kind}-error`);
  busy = true; errorBox.textContent = '';
  form.querySelectorAll('button, input, textarea').forEach(el => el.disabled = true);
  try {
    const issue_key = form.dataset.key;
    if (demo) {
      const ticket = tickets.find(t => t.ticket_key === issue_key);
      if (kind === 'links') ticket.pr_urls = args.urls || [];
      else Object.assign(ticket, args);
    } else {
      const { error } = await client.rpc(action, { issue_key, ...args, expected_revision: Number(form.dataset.revision) });
      if (error) throw error;
    }
    $(`#${kind}-dialog`).close();
    notice(demo ? 'Demo changes saved in this preview only.' : success);
  } catch (error) {
    errorBox.textContent = error.code === '40001'
      ? 'The queue changed while you were editing. Your input is still here to copy. Close this dialog, refresh, and reopen it before saving again.'
      : 'Could not save. Your input is still here; check your connection and try again.';
  } finally {
    busy = false;
    form.querySelectorAll('button, input, textarea').forEach(el => el.disabled = false);
    render(); await load();
  }
}
function saveLinks(urls) {
  return saveTeamEdit('links', 'set_pr_links', { urls }, 'PR links saved for everyone.');
}
$('#context-form').onsubmit = e => {
  e.preventDefault();
  const review_note = $('#review-note').value.trim();
  if (review_note.length > 500) { $('#context-error').textContent = 'Keep the note to 500 characters or fewer.'; return; }
  saveTeamEdit('context', 'set_review_context', {
    urgency: $('#context-form input[name="urgency"]:checked').value,
    client_waiting: $('#client-waiting').checked,
    review_note,
  }, 'Priority and note saved for everyone.');
};
$('#links-form').onsubmit = e => {
  e.preventDefault(); const urls = [...new Set($('#pr-input').value.split('\n').map(s => s.trim()).filter(Boolean))];
  if (urls.length > 20 || urls.some(u => !safeLink(u, 'pr'))) { $('#links-error').textContent = 'Enter up to 20 valid https://github.com/owner/repo/pull/123 URLs.'; return; }
  saveLinks(urls);
};
$('#auto-links').onclick = () => saveLinks(null);
$('#reload').onclick = async () => { if (dirty) { notice('Save or discard your changes before refreshing.'); return; } notice(''); await load(); };
$('#sync').onclick = async () => {
  if (dirty || busy || !client || !admin) return;
  busy = true; render(); notice('Syncing the REVIEW column from Jira…');
  try {
    const { data, error } = await client.functions.invoke('sync-jira', { headers: { 'x-admin-key': adminKey } });
    if (error) {
      let message = 'Jira sync failed. The last saved queue is still available.';
      if (error.context?.json) { try { message = (await error.context.json()).error || message; } catch {} }
      throw new Error(message);
    }
    notice(`Synced ${data.count} tickets.${data.prLookupFailures ? ' Some PR links could not be refreshed; you can edit them manually.' : ''}`);
  } catch (error) { notice(error.message, true); }
  finally { busy = false; render(); await load(); }
};
$('#share').onclick = async () => {
  const shareUrl = new URL(location.href); shareUrl.search = ''; shareUrl.hash = '';
  try { await navigator.clipboard.writeText(shareUrl.href); notice('Team link copied.'); }
  catch { notice(`Team link: ${shareUrl.href}`); }
};
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => { if (!busy) $(`#${b.dataset.close}`).close(); });
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('cancel', e => { if (busy) e.preventDefault(); }));
$('#signout').onclick = async () => {
  if (dirty && !confirm('Discard your unsaved ordering changes and exit admin view?')) return;
  adminKey = ''; try { sessionStorage.removeItem(adminStorageKey); } catch {}
  history.replaceState(null, '', location.pathname);
  admin = false; dirty = false; render(); await load(); notice('Team view.');
};
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

async function initialize() {
if (demo) {
  tickets = demoTickets; savedOrder = tickets.map(t => t.ticket_key); admin = true; render();
  notice('DEMO · Fictional tickets. Changes stay in this browser preview.');
} else if (!client) {
  render(); $('#reload').disabled = true;
  $('#rows').innerHTML = '<div class="empty"><span class="empty-symbol">↗</span><h3>Your review desk is ready to connect</h3><p>Add your Supabase project URL and publishable key to activate the queue.</p><a class="button primary" href="?demo">Explore the demo</a></div>';
  notice('Setup pending · No Jira or Supabase connection yet.');
} else {
  if (adminParam) {
    try {
      if (!adminKey) throw new Error('Invalid link');
      await adminCall('verify'); admin = true;
    } catch {
      adminKey = ''; try { sessionStorage.removeItem(adminStorageKey); } catch {}
      notice('This admin link is invalid or has expired. The public queue is still available.', true);
    }
  }
  await load();
  setInterval(() => { if (!document.hidden && !$('#links-dialog').open) load(); }, 30_000);
}
}
initialize().catch(() => notice('Could not connect to the review queue. Check your connection and reload.', true));
