/*
 * Owner-only admin panel: overview, the sign-up switch and the user list with ban and delete.
 * Every number and change goes through the admin_* functions in supabase/schema.sql, which check on
 * the server that the caller is in app_admins; this page only decides whether to show the Admin
 * button (cloud-sync.js asks is_admin() once per sign-in). Data from the server is rendered with
 * textContent only.
 */
document.addEventListener('DOMContentLoaded', () => {
    const view = document.getElementById('adminView');
    if (!view) return;

    const $ = (id) => document.getElementById(id);
    const els = {
        heading: view.querySelector('h1'),
        status: $('adminStatus'),
        refresh: $('adminRefreshBtn'),
        back: $('adminBackBtn'),
        message: $('adminMessage'),
        stats: $('adminStats'),
        signups: $('adminSignupsSwitch'),
        signupsState: $('adminSignupsState'),
        users: $('adminUsers'),
        userCount: $('adminUserCount'),
        keepalive: $('adminKeepalive')
    };
    const sync = () => window.CloudSync;
    const app = () => window.ComicReader;

    // the keepalive workflow of this site's repository: <user>.github.io/<repo>/, else this project's
    const REPO = (() => {
        const host = window.location.hostname;
        if (host.endsWith('.github.io')) {
            const owner = host.split('.')[0];
            const repo = window.location.pathname.split('/')[1] || host;
            return `${owner}/${repo}`;
        }
        return 'mersahin/Web-Comic-Reader';
    })();
    const KEEPALIVE_URL = `https://api.github.com/repos/${REPO}/actions/workflows/supabase-keepalive.yml/runs?per_page=1`;
    const KEEPALIVE_TTL = 5 * 60 * 1000; // unauthenticated GitHub API: 60 requests an hour per address

    let loadSeq = 0;        // only the newest load renders
    let loading = false;
    let signupsOpen = null; // as the server last said
    let switching = false;  // a change of the sign-up switch is on its way (the switch keeps the focus)
    let keepaliveAt = 0;

    /* ---------------- helpers ---------------- */

    function showMessage(text, kind = 'info') {
        if (!text) {
            els.message.hidden = true;
            return;
        }
        els.message.textContent = text;
        els.message.dataset.kind = kind;
        els.message.hidden = false;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    const parse = (iso) => {
        const ms = Date.parse(iso);
        return Number.isFinite(ms) ? ms : 0;
    };

    function formatAgo(ms) {
        const seconds = Math.round((Date.now() - ms) / 1000);
        if (seconds < 60) return 'just now';
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        if (seconds < 30 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
        return new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });
    }

    // <time> with a short text and the full date as its title; "never" without a date
    function timeNode(iso, relative) {
        const ms = parse(iso);
        if (!ms) return el('span', 'admin-none', 'never');
        const node = el('time', '', relative ? formatAgo(ms) : new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' }));
        node.dateTime = new Date(ms).toISOString();
        node.title = new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        return node;
    }

    function formatBytes(bytes) {
        const n = Number(bytes) || 0;
        if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
        if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
        return `${Math.round(n / 1024)} KB`;
    }

    // fixed texts for what the admin functions can answer
    function errorText(res) {
        const error = (res && res.error) || {};
        if (res && (res.status === 404 || error.code === 'PGRST202')) {
            return 'The admin functions are missing on the server. Run the latest supabase/schema.sql in the Supabase SQL editor.';
        }
        if (error.code === '42501') return 'This account is not an admin. Add it to public.app_admins (see the README) and sign in again.';
        if (error.code === '22023') return 'That is not possible for your own account. Use the account view instead.';
        if (error.code === 'P0002') return 'That user no longer exists. The list is refreshed.';
        if (res && res.status === 0) return 'Could not reach the server. Check your connection and try again.';
        return error.message || 'The request failed.';
    }

    async function rpc(fn, args) {
        try {
            return await sync().rpc(fn, args);
        } catch (err) {
            return { data: null, error: { message: err.message || String(err) }, status: 0 };
        }
    }

    const account = () => (sync() && sync().account ? sync().account() : null);

    // what the panel showed of the previous account goes away
    function clear() {
        loadSeq++; // a load still on its way is dropped
        setLoading(false);
        els.stats.replaceChildren();
        els.users.replaceChildren();
        els.userCount.textContent = '';
        signupsOpen = null;
        renderSignups();
        showMessage('');
        els.status.textContent = 'Owner tools for this site\'s sync accounts';
    }

    function setLoading(on) {
        loading = on;
        els.refresh.disabled = on;
        view.querySelectorAll('.admin-section').forEach((section) => section.setAttribute('aria-busy', String(on)));
        els.users.querySelectorAll('button').forEach((button) => { button.disabled = on; });
        if (on) els.signups.disabled = true;
    }

    /* ---------------- rendering ---------------- */

    function renderStats(o) {
        const items = [
            ['Users', o.users_total],
            ['Confirmed', o.users_confirmed],
            ['Signed in, 7 days', o.signed_in_7d],
            ['Signed in, 30 days', o.signed_in_30d],
            ['Synced, 7 days', o.active_7d],
            ['Banned', o.users_banned],
            ['Comics with progress', o.progress_rows],
            ['Settings rows', o.settings_rows],
            ['Database size', formatBytes(o.db_size_bytes), 'Free plan limit: 500 MB']
        ];
        const nodes = items.map(([label, value, note]) => {
            const card = el('div', 'admin-stat');
            card.append(el('dt', 'admin-stat-label', label), el('dd', 'admin-stat-value', value === undefined || value === null ? '–' : value));
            if (note) card.append(el('dd', 'admin-stat-note', note));
            return card;
        });
        els.stats.replaceChildren(...nodes);
    }

    function renderSignups() {
        const known = signupsOpen !== null;
        els.signups.setAttribute('aria-checked', String(Boolean(signupsOpen)));
        els.signups.disabled = !known || loading;
        els.signupsState.textContent = known ? (signupsOpen ? 'On' : 'Off') : '';
    }

    const COLUMNS = ['User', 'Created', 'Last sign-in', 'Confirmed', 'Comics', 'Last activity', 'Actions'];

    function cell(label, content) {
        const td = el('td', 'admin-cell');
        td.setAttribute('role', 'cell');
        // the label shows only where the rows are stacked (narrow screens); the column header names it for screen readers
        const tag = el('span', 'admin-cell-label', label);
        tag.setAttribute('aria-hidden', 'true');
        td.append(tag);
        if (content instanceof Node) td.append(content);
        else td.append(el('span', '', content));
        return td;
    }

    function badge(text, kind) {
        return el('span', `admin-badge admin-badge-${kind}`, text);
    }

    function actionButton(text, action, user, danger) {
        const button = el('button', `link-btn link-btn-small${danger ? ' admin-danger' : ''}`, text);
        button.type = 'button';
        button.dataset.action = action;
        button.dataset.userId = user.id;
        button.dataset.email = user.email || '';
        button.setAttribute('aria-label', `${text} ${user.email || 'this user'}`);
        return button;
    }

    function renderUsers(list, me) {
        els.userCount.textContent = `(${list.length})`;
        if (!list.length) {
            els.users.replaceChildren(el('p', 'finder-empty', 'No users yet.'));
            return;
        }
        // explicit roles: the narrow layout changes the display of the table parts, which drops their semantics in some browsers
        const table = el('table', 'admin-table');
        table.setAttribute('role', 'table');
        const caption = el('caption', 'visually-hidden', 'Users, most recent activity first');
        const thead = el('thead');
        thead.setAttribute('role', 'rowgroup');
        const headRow = el('tr');
        headRow.setAttribute('role', 'row');
        COLUMNS.forEach((name) => {
            const th = el('th', '', name);
            th.scope = 'col';
            th.setAttribute('role', 'columnheader');
            headRow.append(th);
        });
        thead.append(headRow);
        const tbody = el('tbody');
        tbody.setAttribute('role', 'rowgroup');
        const now = Date.now();
        list.forEach((user) => {
            const self = Boolean(me) && user.id === me.id;
            const banned = parse(user.banned_until) > now;
            const tr = el('tr', banned ? 'is-banned' : '');
            tr.setAttribute('role', 'row');
            tr.dataset.userId = user.id;

            const who = el('div', 'admin-user');
            who.append(el('span', 'admin-email', user.email || '(no email)'));
            const badges = el('span', 'admin-badges');
            if (self) badges.append(badge('You', 'self'));
            if (user.is_admin) badges.append(badge('Admin', 'admin'));
            if (banned) badges.append(badge('Banned', 'banned'));
            if (!user.email_confirmed_at) badges.append(badge('Unconfirmed', 'muted'));
            if (badges.childNodes.length) who.append(badges);
            const first = cell('User', who);
            first.classList.add('admin-cell-user');

            const actions = el('div', 'admin-actions');
            if (self) {
                actions.append(el('span', 'admin-none', 'Use the account view'));
            } else {
                actions.append(
                    actionButton(banned ? 'Unban' : 'Ban', banned ? 'unban' : 'ban', user, false),
                    actionButton('Delete data', 'delete-data', user, true),
                    actionButton('Delete user', 'delete-user', user, true)
                );
            }
            tr.append(
                first,
                cell('Created', timeNode(user.created_at, false)),
                cell('Last sign-in', timeNode(user.last_sign_in_at, true)),
                cell('Confirmed', user.email_confirmed_at ? 'Yes' : 'No'),
                cell('Comics', String(Number(user.comics) || 0)),
                cell('Last activity', timeNode(user.last_activity, true)),
                cell('Actions', actions)
            );
            tr.lastElementChild.classList.add('admin-cell-actions');
            tbody.append(tr);
        });
        table.append(caption, thead, tbody);
        els.users.replaceChildren(table);
    }

    function renderKeepalive(state) {
        const box = els.keepalive;
        box.replaceChildren();
        if (state.loading) {
            box.textContent = 'Checking GitHub…';
            return;
        }
        if (state.error) {
            box.append(el('span', 'admin-none', state.error));
            return;
        }
        const run = state.run;
        if (!run) {
            box.textContent = 'No runs of the Supabase keepalive workflow yet.';
            return;
        }
        const ok = run.status === 'completed' && run.conclusion === 'success';
        const label = run.status !== 'completed' ? 'Running' : ok ? 'Succeeded' : run.conclusion === 'failure' ? 'Failed' : 'Finished without success';
        const line = el('div', 'admin-keepalive-line');
        const dot = el('span', `admin-dot admin-dot-${run.status !== 'completed' ? 'pending' : ok ? 'ok' : 'error'}`);
        dot.setAttribute('aria-hidden', 'true');
        line.append(dot, el('strong', '', `Last run: ${label}`), document.createTextNode(' · '), timeNode(run.created_at, true));
        box.append(line);
        // only links into github.com are shown
        if (typeof run.html_url === 'string' && run.html_url.startsWith('https://github.com/')) {
            const a = el('a', '', 'View the run on GitHub');
            a.href = run.html_url;
            a.target = '_blank';
            a.rel = 'noopener';
            box.append(a);
        }
    }

    /* ---------------- loading ---------------- */

    async function load({ keepFocus = null } = {}) {
        const me = account();
        if (!me || !me.admin) {
            clear();
            showMessage('The admin panel is only for the site owner. Sign in with an admin account.', 'error');
            return;
        }
        const seq = ++loadSeq;
        setLoading(true);
        els.status.textContent = els.users.childNodes.length ? 'Refreshing…' : 'Loading…';
        if (!els.users.childNodes.length) {
            const wait = el('div', 'finder-loading');
            wait.append(el('div', 'finder-spinner'), el('span', '', 'Loading users…'));
            els.users.replaceChildren(wait);
        }
        const [overview, users] = await Promise.all([rpc('admin_overview'), rpc('admin_list_users')]);
        if (seq !== loadSeq) return;
        setLoading(false);
        const failed = overview.error ? overview : users.error ? users : null;
        if (failed) {
            // not an admin (any more) or no admin functions: nothing stays; offline: the last data stays
            if (failed.error.code === '42501' || failed.error.code === 'PGRST202' || failed.status === 404) clear();
            else if (els.users.querySelector('.finder-loading')) els.users.replaceChildren();
            els.status.textContent = 'Could not load';
            showMessage(errorText(failed), 'error');
            renderSignups();
            return;
        }
        renderStats(overview.data || {});
        signupsOpen = Boolean(overview.data && overview.data.signups_open);
        renderSignups();
        renderUsers(Array.isArray(users.data) ? users.data : [], me);
        els.status.textContent = `Updated ${new Date().toLocaleTimeString(undefined, { timeStyle: 'short' })}`;
        if (keepFocus) restoreFocus(keepFocus);
        loadKeepalive(false);
    }

    // the list was rebuilt: the same button of the same user, else that user's first button, else the heading
    function restoreFocus({ userId, action }) {
        const row = [...els.users.querySelectorAll('tr')].find((tr) => tr.dataset.userId === userId);
        const target = (row && (row.querySelector(`button[data-action="${action}"]`) || row.querySelector('button'))) || els.heading;
        target.focus();
    }

    async function loadKeepalive(force) {
        if (!force && Date.now() - keepaliveAt < KEEPALIVE_TTL) return;
        keepaliveAt = Date.now();
        renderKeepalive({ loading: true });
        try {
            const options = { headers: { Accept: 'application/vnd.github+json' } };
            if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) options.signal = AbortSignal.timeout(10000);
            const res = await fetch(KEEPALIVE_URL, options);
            if (res.status === 403 || res.status === 429) {
                renderKeepalive({ error: 'GitHub\'s hourly limit for status checks is used up. Try again later.' });
                return;
            }
            if (!res.ok) {
                renderKeepalive({ error: 'The workflow status could not be loaded from GitHub.' });
                return;
            }
            const json = await res.json();
            const run = json && Array.isArray(json.workflow_runs) ? json.workflow_runs[0] : null;
            renderKeepalive({ run: run || null });
        } catch (err) {
            renderKeepalive({ error: 'The workflow status could not be loaded from GitHub.' });
        }
    }

    /* ---------------- actions ---------------- */

    els.signups.addEventListener('click', async () => {
        if (signupsOpen === null || loading || switching) return;
        const next = !signupsOpen;
        switching = true;
        els.signups.setAttribute('aria-busy', 'true');
        showMessage('');
        const res = await rpc('admin_set_signups', { open: next });
        switching = false;
        els.signups.removeAttribute('aria-busy');
        if (res.error) {
            showMessage(errorText(res), 'error');
        } else {
            signupsOpen = Boolean(res.data);
            showMessage(signupsOpen
                ? 'New sign-ups are switched on.'
                : 'New sign-ups are switched off. They are refused only while the Before User Created hook is enabled in the Supabase dashboard.', 'info');
        }
        renderSignups();
    });

    const CONFIRMS = {
        ban: (email) => `Ban ${email}?\nThey can no longer sign in or renew their session. A session they already have keeps working for up to an hour. You can unban them later.`,
        unban: (email) => `Unban ${email}? They can sign in again.`,
        'delete-data': (email) => `Delete the synced data of ${email}?\nTheir reading progress, settings and channel list are removed from the server. Their account stays, and their devices keep their own copies.`,
        'delete-user': (email) => `Delete the user ${email} for good?\nThe account and all its synced data are removed from the server. This cannot be undone.`
    };
    const DONE = {
        ban: (email) => `${email} is banned.`,
        unban: (email) => `${email} is no longer banned.`,
        'delete-data': (email, data) => {
            const comics = Number(data && data.progress_rows) || 0;
            const settings = Number(data && data.settings_rows) > 0;
            return `The synced data of ${email} was deleted: ${comics} comic${comics === 1 ? '' : 's'}${settings ? ' and the settings' : ', no settings'}.`;
        },
        'delete-user': (email) => `The user ${email} was deleted.`
    };

    els.users.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button || loading) return;
        const { action, userId, email } = button.dataset;
        if (!CONFIRMS[action] || !confirm(CONFIRMS[action](email))) return;
        showMessage('');
        setLoading(true);
        let res;
        if (action === 'ban' || action === 'unban') res = await rpc('admin_set_banned', { target: userId, banned: action === 'ban' });
        else if (action === 'delete-data') res = await rpc('admin_delete_user_data', { target: userId });
        else res = await rpc('admin_delete_user', { target: userId });
        setLoading(false);
        if (res.error) showMessage(errorText(res), 'error');
        else showMessage(DONE[action](email, res.data), 'info');
        // the message is announced; the focus stays on the row (after Ban its button says Unban), or
        // moves to the heading when the row is gone
        const next = action === 'ban' ? 'unban' : action === 'unban' ? 'ban' : action;
        await load({ keepFocus: { userId, action: next } });
    });

    els.refresh.addEventListener('click', () => {
        showMessage('');
        loadKeepalive(true);
        load();
    });

    els.back.addEventListener('click', () => {
        if (app()) app().showAccount();
        const adminBtn = $('syncAdminBtn');
        if (adminBtn && adminBtn.getClientRects().length) adminBtn.focus();
    });

    // signed out, another account, or no admin any more: nothing of the panel stays on the page
    document.addEventListener('cloudsync:account-changed', () => {
        const me = account();
        if (me && me.admin) return;
        clear();
        if (view.style.display === 'block' && app()) app().showAccount();
    });

    window.AdminPanel = {
        onShow() {
            els.heading.focus();
            load();
        }
    };
});
