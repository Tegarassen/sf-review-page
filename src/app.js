import { createClient } from '@supabase/supabase-js';
import './style.css';

const $ = (s) => document.querySelector(s);
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const demo = new URLSearchParams(location.search).has('demo');
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const configured = url?.startsWith('https://') && key && !url.includes('YOUR_PROJECT') && !key.includes('REPLACE_ME');
const client = configured && !demo ? createClient(url, key) : null;
let tickets = [], revision = 0, admin = false, dirty = false, busy = false, lastSynced = null, draggedKey = null;
let savedOrder = [];
const demoTickets = [
  ['SP-1001', 'Improve the photo upload experience'],
  ['SP-1002', 'Fix form preview on mobile'],
  ['SP-1003', 'Update document checklist'],
  ['SP-1004', 'Refine album selection'],
].map(([ticket_key, short_title], i) => ({ ticket_key, short_title, position: i + 1, jira_url: '', pr_urls: [] }));

$('#app').innerHTML = `
  <header class="topbar"><div class="brand"><span class="brand-mark">S</span> SharinPix <span class="brand-divider">/</span> <span class="brand-sub">Engineering</span></div><div class="top-actions"><span class="live-dot"></span><span>Salesforce team</span><button id="admin-login" class="button subtle">Admin sign in</button><button id="signout" class="button subtle" hidden>Sign out</button></div></header>
  <main>
    <div class="eyebrow">THE REVIEW DESK <span>BOARD 45</span></div>
    <section class="heading"><div><h1>A little order.<br><span>A faster review.</span></h1><p>One shared queue. Start at the top and work your way down.</p></div><button id="share" class="button">Copy team link <span aria-hidden="true">↗</span></button></section>
    <div id="notice" role="status" aria-live="polite" hidden></div>
    <section class="summary" aria-label="Queue overview"><div><span class="summary-label">WAITING FOR REVIEW</span><strong id="count">—</strong></div><div><span class="summary-label">QUEUE ORDER</span><strong class="summary-text" id="order-label">Team priority</strong></div><div><span class="summary-label">LAST JIRA SYNC</span><strong class="summary-text" id="synced">Not synced yet</strong></div></section>
    <section class="queue"><div class="queue-heading"><div><span class="tab-dot"></span><h2>Review queue</h2><span id="badge">0</span></div><button id="reload" class="button subtle">Refresh</button></div>
      <div id="admin-toolbar" hidden><p>Drag rows or use the arrows, then save the order for everyone.</p><div><button id="sync" class="button subtle">Sync Jira</button><button id="discard" class="button subtle" disabled>Discard changes</button><button id="save" class="button primary" disabled>Save order</button></div></div>
      <div class="table-head"><span>ORDER</span><span>TICKET</span><span>PULL REQUESTS</span><span></span></div>
      <div id="rows" aria-label="Tickets in review order"><div class="empty">Loading the review queue…</div></div>
      <footer class="queue-footer"><span>Review from top to bottom.</span><span>Jira · SP / REVIEW</span></footer>
    </section>
    <footer class="page-footer"><span>Small queue. Clear priorities.</span><span>Ticket details and code remain in Jira and GitHub.</span></footer>
  </main>
  <dialog id="login-dialog"><form id="login-form"><div class="dialog-heading"><h2>Admin sign in</h2><button type="button" class="button subtle" data-close="login-dialog" aria-label="Close">×</button></div><p>Sign in to set the team's review order.</p><label>Email<input id="email" type="email" autocomplete="username" required></label><label>Password<input id="password" type="password" autocomplete="current-password" required></label><p id="login-error" role="alert"></p><button id="login-submit" class="button primary" type="submit">Sign in</button></form></dialog>
  <dialog id="links-dialog"><form id="links-form"><div class="dialog-heading"><h2 id="links-title">PR links</h2><button type="button" class="button subtle" data-close="links-dialog" aria-label="Close">×</button></div><p>Paste one GitHub pull request URL per line. These links stay saved when Jira refreshes.</p><label>Pull request links<textarea id="pr-input" rows="5" placeholder="https://github.com/team/repo/pull/123"></textarea></label><p id="links-error" role="alert"></p><div class="dialog-actions"><button type="button" id="auto-links" class="button">Use synced links</button><button type="submit" class="button primary">Save links</button></div></form></dialog>
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
function render() {
  $('#count').textContent = String(tickets.length).padStart(2, '0');
  $('#badge').textContent = tickets.length;
  $('#synced').textContent = demo ? 'Sample data' : lastSynced ? new Date(lastSynced).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not synced yet';
  $('#admin-toolbar').hidden = !admin;
  $('#admin-login').hidden = admin || !client;
  $('#signout').hidden = !admin || demo;
  $('#save').disabled = !dirty || busy;
  $('#discard').disabled = !dirty || busy;
  $('#sync').disabled = dirty || busy || demo;
  $('#order-label').textContent = dirty ? 'Unsaved changes' : 'Team priority';
  $('#rows').innerHTML = tickets.length ? tickets.map((t, i) => `
    <article class="ticket ${i === 0 ? 'first' : ''}" data-key="${escape(t.ticket_key)}" draggable="${admin && !busy}">
      <div class="rank"><span class="drag-handle" aria-hidden="true">${admin ? '⠿' : ''}</span><span>${String(i + 1).padStart(2, '0')}</span></div>
      <div class="ticket-info"><div class="ticket-meta">${safeLink(t.jira_url, 'jira') ? `<a href="${escape(t.jira_url)}" target="_blank" rel="noopener noreferrer">${escape(t.ticket_key)} ↗</a>` : `<span>${escape(t.ticket_key)}</span>`}${i === 0 ? '<span class="next-badge">UP NEXT</span>' : ''}</div><h3>${escape(t.short_title)}</h3></div>
      <div class="pr-links">${t.pr_urls.filter(u => safeLink(u, 'pr')).map((u, n) => `<a class="pr-link" href="${escape(u)}" target="_blank" rel="noopener noreferrer">PR #${escape(u.split('/').pop())} ↗</a>`).join('') || '<span class="muted">PR link pending</span>'}${admin ? `<button class="text-button" data-links="${escape(t.ticket_key)}" ${busy ? 'disabled' : ''}>Edit links</button>` : ''}</div>
      <div class="move-controls">${admin ? `<button class="move" data-move="-1" data-key="${escape(t.ticket_key)}" aria-label="Move ${escape(t.ticket_key)} up" ${i === 0 || busy ? 'disabled' : ''}>↑</button><button class="move" data-move="1" data-key="${escape(t.ticket_key)}" aria-label="Move ${escape(t.ticket_key)} down" ${i === tickets.length - 1 || busy ? 'disabled' : ''}>↓</button>` : ''}</div>
    </article>`).join('') : '<div class="empty"><span class="empty-symbol">✓</span><h3>No tickets waiting</h3><p>Tickets will appear here after Jira syncs the REVIEW column.</p></div>';
}
async function load() {
  if (!client || dirty || busy) return;
  const { data, error } = await client.rpc('get_queue');
  if (error) { notice('Could not refresh the queue. Check the connection and try again.', true); return; }
  if (dirty || busy) return;
  tickets = data.tickets; revision = data.revision; lastSynced = data.last_synced_at;
  savedOrder = tickets.map(t => t.ticket_key); render();
  if (lastSynced && Date.now() - new Date(lastSynced).getTime() > 45 * 60 * 1000) notice('Jira has not synced recently. This is the last saved queue.');
}
function reorder(from, to) {
  if (!admin || busy || from === to || from < 0 || to < 0 || to >= tickets.length) return;
  tickets.splice(to, 0, tickets.splice(from, 1)[0]);
  dirty = tickets.some((t, i) => t.ticket_key !== savedOrder[i]); render();
}
$('#rows').addEventListener('click', e => {
  const move = e.target.closest('[data-move]');
  if (move) { const i = tickets.findIndex(t => t.ticket_key === move.dataset.key); reorder(i, i + Number(move.dataset.move)); }
  const links = e.target.closest('[data-links]');
  if (links && admin) {
    if (dirty) { notice('Save or discard your ordering changes before editing PR links.'); return; }
    const ticket = tickets.find(t => t.ticket_key === links.dataset.links);
    $('#links-form').dataset.key = ticket.ticket_key;
    $('#links-title').textContent = `${ticket.ticket_key} · PR links`;
    $('#pr-input').value = ticket.pr_urls.join('\n'); $('#links-error').textContent = '';
    $('#links-dialog').showModal();
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
      const { error } = await client.rpc('save_order', { ticket_keys: tickets.map(t => t.ticket_key), expected_revision: revision });
      if (error) throw error;
      dirty = false; notice('Order saved. Everyone with the team link can see it.');
    }
  } catch (error) { notice(error.code === '40001' ? 'The queue changed while you were editing. Discard changes to load the latest queue, then reorder again.' : 'Could not save. Your changes are still here; check your admin access and retry.', true); }
  finally { busy = false; render(); if (!dirty) await load(); }
};
async function saveLinks(urls) {
  busy = true; $('#links-error').textContent = '';
  $('#links-form').querySelectorAll('button').forEach(b => b.disabled = true);
  try {
    const issue_key = $('#links-form').dataset.key;
    if (demo) { tickets.find(t => t.ticket_key === issue_key).pr_urls = urls || []; }
    else {
      const { error } = await client.rpc('set_pr_links', { issue_key, urls, expected_revision: revision });
      if (error) throw error;
    }
    $('#links-dialog').close(); notice(demo ? 'Demo links updated in this preview only.' : 'PR links saved.');
  } catch { $('#links-error').textContent = 'Could not save links. Close this dialog, refresh the queue, and try again.'; }
  finally { busy = false; $('#links-form').querySelectorAll('button').forEach(b => b.disabled = false); render(); await load(); }
}
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
    const { data, error } = await client.functions.invoke('sync-jira');
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
$('#admin-login').onclick = () => $('#login-dialog').showModal();
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => $(`#${b.dataset.close}`).close());
$('#login-form').onsubmit = async e => {
  e.preventDefault(); $('#login-submit').disabled = true; $('#login-error').textContent = '';
  try {
    const { data, error } = await client.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#password').value });
    $('#password').value = '';
    if (error) throw error;
    const { data: permission, error: permissionError } = await client.from('queue_admins').select('user_id').eq('user_id', data.user.id).maybeSingle();
    if (permissionError || !permission) { await client.auth.signOut(); throw new Error('This account has not been added as a queue admin.'); }
    admin = true; $('#login-dialog').close(); notice('You can now set the review order.'); render();
  } catch (error) { $('#login-error').textContent = error.message; }
  finally { $('#login-submit').disabled = false; }
};
$('#signout').onclick = async () => {
  if (dirty && !confirm('Discard your unsaved ordering changes and sign out?')) return;
  await client.auth.signOut(); admin = false; dirty = false; render(); await load(); notice('Signed out.');
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
  const { data: { session } } = await client.auth.getSession();
  if (session) {
    const { data } = await client.from('queue_admins').select('user_id').eq('user_id', session.user.id).maybeSingle(); admin = !!data;
  }
  client.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') { admin = false; dirty = false; render(); } });
  await load();
  setInterval(() => { if (!document.hidden && !$('#links-dialog').open) load(); }, 30_000);
}
}
initialize().catch(() => notice('Could not connect to the review queue. Check your connection and reload.', true));
