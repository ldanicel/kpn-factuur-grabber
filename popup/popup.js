const $ = (id) => document.getElementById(id);
const STALE_MS = 30 * 60 * 1000;

const STATUS_TEXT = {
  ok: (s) => `Newest invoice: ${s.lastNewest}.` + (s.lastError ? ` ${s.lastError}.` : ''),
  login: () => '',
  'not-found': () => 'No invoices found on MijnKPN. The page may have changed.',
  error: (s) => `Something went wrong: ${s.lastError || 'unknown error'}.`,
};

function renderAccount(account) {
  const el = $('account');
  el.classList.toggle('out', !!account && !account.loggedIn);
  if (!account) el.textContent = 'Checking KPN login…';
  else if (account.loggedIn) el.innerHTML = '<span class="dot"></span>Logged in to KPN' + (account.id ? ' as ' : '');
  else el.innerHTML = '<span class="dot"></span>Not logged in to KPN';
  if (account && account.loggedIn && account.id) el.append(account.id);
  $('login').hidden = !account || account.loggedIn;
}

// A run that died (browser closed mid-way) leaves its last step behind; ignore it after a few minutes.
const live = (p) => p && Date.now() - (p.at || 0) < 3 * 60 * 1000;

function renderProgress(p) {
  if (!live(p)) p = null;
  $('progress').hidden = !p;
  if (!p) return;
  $('progress-text').textContent = p.text;
  const list = $('progress-list');
  list.replaceChildren(
    ...p.saved.map((name) => Object.assign(document.createElement('li'), { textContent: `✓ ${name}` })),
    ...p.failed.map((date) => Object.assign(document.createElement('li'), { textContent: `✗ ${date} failed`, className: 'fail' })),
  );
  list.scrollTop = list.scrollHeight;
}

chrome.storage.onChanged.addListener((changes) => {
  if (!changes.progress) return;
  if (changes.progress.newValue) renderProgress(changes.progress.newValue);
  else render();
});

async function render() {
  const s = await chrome.storage.local.get(null);
  const fn = STATUS_TEXT[s.lastStatus];
  $('status').textContent = fn ? fn(s) : '';
  renderAccount(s.account);
  renderProgress(s.progress);
  const busy = live(s.progress);
  for (const b of document.querySelectorAll('button')) b.disabled = busy;
  $('auto').checked = s.auto !== false;
  $('folder').value = s.folder || 'Facturen';
  return s;
}

async function run(mode) {
  for (const b of document.querySelectorAll('button')) b.disabled = true;
  $('status').textContent = '';
  const res = await chrome.runtime.sendMessage({ type: 'run', mode });
  if (res && res.status === 'ok') $('status').textContent = `Saved ${res.saved} invoice${res.saved === 1 ? '' : 's'}${res.failed ? `, ${res.failed} failed` : ''}.`;
  const keep = $('status').textContent;
  await render();
  if (keep) $('status').textContent = keep;
}

$('run').onclick = () => run('latest-month');
$('all').onclick = () => run('all');
$('login').onclick = () => chrome.runtime.sendMessage({ type: 'open-login' });
$('outline').onclick = async (e) => {
  e.preventDefault();
  $('status').textContent = 'Saving page outline…';
  const ok = await chrome.runtime.sendMessage({ type: 'outline' });
  $('status').textContent = ok ? 'Saved factuur-grabber-outline.json in Downloads.' : "Couldn't save the outline.";
};
$('auto').onchange = (e) => chrome.storage.local.set({ auto: e.target.checked });
$('folder').onchange = (e) => chrome.storage.local.set({ folder: e.target.value.trim() || 'Facturen' });

render().then(async (s) => {
  if (!s.account || Date.now() - s.account.checkedAt > STALE_MS) {
    const account = await chrome.runtime.sendMessage({ type: 'check-account' });
    if (account) renderAccount(account);
    else $('account').textContent = "Couldn't check the KPN login right now.";
  }
});
