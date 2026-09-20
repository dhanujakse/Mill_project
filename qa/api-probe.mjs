// QA API probe - run ONLY against an isolated test server (see docs/TEST_PLAN.md section 2). It creates users/requests, hammers /auth/login and finally demotes the admin account, so never point it at production or your real dev database.
// Usage: node qa/api-probe.mjs   (expects API at http://localhost:4100/api with a fresh seeded DB)
const B = 'http://localhost:4100/api';
const out = [];
const rec = (id, title, expected, actual, verdict) => out.push({ id, title, expected, actual, verdict });

const call = async (method, path, { token, body, raw } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(B + path, { method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    let json = null; const text = await res.text();
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text: text.slice(0, 120) };
  } catch (e) { return { status: 'NETERR', json: null, text: e.message }; }
};
const login = async (u, p) => (await call('POST', '/auth/login', { body: { username: u, password: p } }));

const admin = (await login('admin', 'Password123!')).json.token;
const emp = (await login('employee', 'Password123!')).json.token;
const empUser = (await login('employee', 'Password123!')).json.user;

// ---------- AUTH ----------
let r = await call('GET', '/requests');
rec('SEC-01', 'No token -> protected endpoint', '401', r.status, r.status === 401 ? 'PASS' : 'FAIL');
r = await call('GET', '/requests', { token: 'garbage.token.value' });
rec('SEC-02', 'Tampered token', '401', r.status, r.status === 401 ? 'PASS' : 'FAIL');
r = await login('ADMIN', 'Password123!');
rec('AUTH-03', 'Username case-insensitive login', '200 (by design)', r.status, r.status === 200 ? 'INFO' : 'CHECK');
r = await login('admin', ' Password123! ');
rec('AUTH-04', 'Password with surrounding spaces is trimmed', 'ambiguous', r.status, 'INFO');
r = await login('admin', '');
rec('AUTH-05', 'Empty password', '400', r.status, r.status === 400 ? 'PASS' : 'FAIL');
r = await login('admin', 'x'.repeat(100000));
rec('AUTH-06', '100KB password (bcrypt long input)', '401 quickly, no crash', r.status, r.status === 401 ? 'PASS' : 'FAIL');
r = await login("admin' OR '1'='1", 'x');
rec('SEC-07', 'SQL-injection style username', '401', r.status, r.status === 401 ? 'PASS' : 'FAIL');
let last; const t0 = Date.now();
for (let i = 0; i < 25; i++) last = await login('admin', 'wrong' + i);
rec('SEC-08', '25 rapid wrong-password attempts (lockout / throttle?)', '429/lockout at some point', `last=${last.status} in ${Date.now() - t0}ms`, last.status === 429 ? 'PASS' : 'FAIL (no throttling)');
r = await login('admin', 'Password123!');
rec('SEC-09', 'Correct login still works after brute-force burst', '200', r.status, r.status === 200 ? 'INFO (no lockout at all)' : 'INFO (locked)');

// ---------- AUTHORIZATION (Employee token) ----------
const mk = (id, extra = {}) => ({ id, employeeName: 'Ramesh Kumar', productName: 'QA item', qty: 1, units: 'Pieces', status: 'Pending', date: new Date().toISOString(), history: [], ...extra });
const rid = 'REQ-QA-' + Date.now();
r = await call('POST', '/requests', { token: emp, body: mk(rid) });
rec('REQ-01', 'Employee creates a request', '201', r.status, r.status === 201 ? 'PASS' : 'FAIL');
r = await call('POST', '/requests', { token: emp, body: mk(rid) });
rec('REQ-02', 'Duplicate request id', '409', r.status, r.status === 409 ? 'PASS' : 'FAIL');
r = await call('POST', '/requests', { token: emp, body: { productName: 'no id' } });
rec('REQ-03', 'Request without id', '400', r.status, r.status === 400 ? 'PASS' : 'FAIL');
r = await call('PUT', `/requests/${rid}`, { token: emp, body: mk(rid, { status: 'Received', poNumber: 'PO-FAKE-1', supplierId: 'sup-1' }) });
rec('AUTHZ-01', 'EMPLOYEE self-approves / sets status Received + fake PO via raw API', '403 Forbidden', r.status, r.status === 403 ? 'PASS' : 'FAIL (any employee can set any status)');
const other = 'REQ-QA-OTHER-' + Date.now();
await call('POST', '/requests', { token: admin, body: mk(other, { employeeName: 'Someone Else' }) });
r = await call('PUT', `/requests/${other}`, { token: emp, body: mk(other, { employeeName: 'Someone Else', status: 'Rejected' }) });
rec('AUTHZ-02', "Employee modifies ANOTHER employee's request", '403', r.status, r.status === 403 ? 'PASS' : 'FAIL (no ownership check)');
r = await call('GET', '/requests', { token: emp });
rec('AUTHZ-03', "Employee GET /requests returns other people's requests", 'only own', `${r.json?.length} rows incl. others`, (r.json || []).some(x => x.employeeName === 'Someone Else') ? 'FAIL (data exposure; UI-only filter)' : 'PASS');
r = await call('PUT', `/requests/${rid}`, { token: emp, body: { status: 'Rejected' } });
rec('DATA-01', 'PUT with partial body wipes stored request (full-replace semantics)', 'reject or merge', r.status, r.status === 200 ? 'FAIL (record overwritten by 1 field)' : 'PASS');
r = await call('GET', '/users', { token: emp });
rec('AUTHZ-04', 'Employee lists users', '403', r.status, r.status === 403 ? 'PASS' : 'FAIL');
r = await call('POST', '/suppliers', { token: emp, body: { id: 'sup-x1', companyName: 'X' } });
rec('AUTHZ-05', 'Employee adds supplier', '403', r.status, r.status === 403 ? 'PASS' : 'FAIL');
r = await call('GET', '/logs', { token: emp });
rec('AUTHZ-06', 'Employee reads audit logs', '403', r.status, r.status === 403 ? 'PASS' : 'FAIL');
r = await call('PUT', '/settings/branding', { token: emp, body: { appName: 'hax' } });
rec('AUTHZ-07', 'Employee edits branding', '403', r.status, r.status === 403 ? 'PASS' : 'FAIL');
r = await call('PUT', `/users/${empUser.id}`, { token: emp, body: { role: 'Main Admin', name: 'Ramesh Kumar', email: 'ramesh@x.com', phone: '9876543210' } });
const meAfter = await call('GET', '/auth/me', { token: emp });
rec('SEC-10', 'Employee escalates OWN role to Main Admin via PUT /users/:id', 'role unchanged', `PUT ${r.status}, role now=${meAfter.json?.role}`, meAfter.json?.role === 'Employee' ? 'PASS' : 'FAIL (privilege escalation)');
r = await call('DELETE', '/notifications', { token: emp });
rec('AUTHZ-08', "Employee clears EVERYONE's notification inbox", '403 / per-user', r.status, r.status === 204 ? 'FAIL (global wipe)' : 'PASS');
r = await call('PATCH', '/notifications/mark-read', { token: emp });
rec('AUTHZ-09', "Employee marks ALL users' notifications read", 'per-user', r.status, r.status === 204 ? 'FAIL (shared read state)' : 'PASS');
r = await call('POST', '/logs', { token: emp, body: { userName: 'admin', role: 'Main Admin', action: 'Deleted All Data', details: 'forged' } });
rec('SEC-11', 'Employee forges audit-log entry attributed to admin', '403 / server-stamped identity', r.status, r.status === 201 ? 'FAIL (log forging)' : 'PASS');

// ---------- USERS (admin) ----------
r = await call('POST', '/users', { token: admin, body: { username: 'qa_role', name: 'Qa Role', email: 'qa_role@x.com', phone: '9876543210', role: 'Superuser', department: 'Nope' } });
rec('USR-01', 'Create user with bogus role + nonexistent department', '400', r.status, r.status === 201 ? 'FAIL (unvalidated role/dept)' : 'PASS');
r = await call('POST', '/users', { token: admin, body: { username: 'qa_dup', name: 'Qa Dup', email: 'QA_DUP@x.com', phone: '9876543210', role: 'Employee', department: 'Kraft Mill', password: 'a' } });
rec('USR-02', 'Create user with 1-char password', '400 (policy)', r.status, r.status === 201 ? 'FAIL (no server password policy)' : 'PASS');
r = await call('POST', '/users', { token: admin, body: { username: 'qa_dup2', name: 'Qa Dup', email: 'qa_dup@x.com', phone: '9876543210', role: 'Employee', department: 'Kraft Mill' } });
rec('USR-03', 'Duplicate email differing only by case', '409', r.status, r.status === 409 ? 'PASS' : 'FAIL');
for (const [n, e, p, label] of [['R2D2', 'a@b.com', '9876543210', 'digits in name'], ['Valid Name', 'bad-email', '9876543210', 'bad email'], ['Valid Name', 'v@b.com', '12345', 'short phone'], ['Valid Name', 'v2@b.com', '+919876543210', 'valid +91 phone'], ['Valid Name', 'v3@b.com', '0987654321', 'phone starting 0'], ['Valid Name', 'v4@b.com', '1234567890', 'phone starting 1 (not a valid Indian mobile)']]) {
  r = await call('POST', '/users', { token: admin, body: { username: 'u' + Math.random().toString(36).slice(2, 7), name: n, email: e, phone: p, role: 'Employee', department: 'Kraft Mill' } });
  rec('USR-04', `User field validation: ${label}`, label.startsWith('valid') ? '201' : '400', r.status, (label.startsWith('valid') ? r.status === 201 : r.status === 400) ? 'PASS' : 'FAIL');
}
// USR-06 (non-string name) removed from batch: it KILLS the server process. See TEST_PLAN BUG-01.

// ---------- CHANGE PASSWORD ----------
const empLogin2 = (await login('employee', 'Password123!')).json.token;
r = await call('POST', '/auth/change-password', { token: empLogin2, body: { currentPassword: 'Password123!', newPassword: 'a' } });
rec('PWD-01', 'change-password to 1 char (server side)', '400 (policy)', r.status, r.status === 200 ? 'FAIL (no policy server-side)' : 'PASS');
r = await call('POST', '/auth/change-password', { token: empLogin2, body: { currentPassword: 'a', newPassword: 'Password123!' } });
rec('PWD-02', 'change-password back (same as old allowed?)', '200', r.status, 'INFO');

// ---------- SUPPLIERS ----------
r = await call('POST', '/suppliers', { token: admin, body: { id: 'sup-1', companyName: 'Dup ID' } });
rec('SUP-01', 'Supplier with existing id', '409', r.status, r.status === 409 ? 'PASS' : `FAIL (${r.status})`);
r = await call('POST', '/suppliers', { token: admin, body: { id: 'sup-blank', companyName: '   ', whatsappNumber: 'abc', email: 'not-an-email', products: 'x' } });
rec('SUP-02', 'Supplier with blank name, letters as phone, invalid email (server)', '400', r.status, r.status === 201 ? 'FAIL (no server validation)' : 'PASS');
r = await call('POST', '/suppliers', { token: admin, body: { id: 'sup-xss', companyName: '<img src=x onerror=alert(1)>', whatsappNumber: '9876543210', products: 'x' } });
rec('SEC-12', 'Supplier name containing HTML/JS is stored (verify escaped in UI)', '201 + escaped render', r.status, 'UI-CHECK');

// ---------- DEPARTMENTS / SETTINGS ----------
r = await call('POST', '/departments', { token: admin, body: { name: '  kraft mill ' } });
rec('DEP-01', 'Department duplicate differing by case/space', '409', r.status, r.status === 409 ? 'PASS' : 'FAIL');
r = await call('PUT', '/settings/branding', { token: admin, body: { appName: 'X' } });
rec('SET-01', 'Branding saved WITHOUT billingLocations/colors', '400 or merge', r.status, r.status === 200 ? 'FAIL (partial branding overwrites all; root cause of earlier blank page)' : 'PASS');
const br = await call('GET', '/settings/branding');
rec('SET-02', 'Public branding after partial save', 'still has billingLocations', JSON.stringify(br.json).slice(0, 60), br.json?.billingLocations ? 'PASS' : 'FAIL');
r = await call('PUT', '/settings/webhook-url', { token: admin, body: { webhookUrl: 'javascript:alert(1)' } });
rec('SET-03', 'Webhook URL accepts non-http scheme', '400', r.status, r.status === 200 ? 'FAIL (no URL validation)' : 'PASS');
await call('PUT', '/settings/webhook-url', { token: admin, body: { webhookUrl: '' } });

// ---------- ROBUSTNESS ----------
r = await call('POST', '/requests', { token: admin, raw: '{"id": "x", ' });
rec('ROB-01', 'Malformed JSON body', '400', r.status, r.status === 400 ? 'PASS' : `FAIL (${r.status}, generic error)`);
r = await call('POST', '/requests', { token: admin, raw: JSON.stringify({ id: 'REQ-BIG-' + Date.now(), blob: 'A'.repeat(16 * 1024 * 1024) }) });
rec('ROB-02', 'Body > 15MB', '413', r.status, r.status === 413 ? 'PASS' : `FAIL (${r.status})`);
r = await call('GET', '/nope', { token: admin });
rec('ROB-03', 'Unknown API route', '404 JSON', `${r.status} ${r.text.slice(0, 40)}`, r.status === 404 && r.json ? 'PASS' : 'MINOR (HTML 404, not JSON)');
r = await call('POST', '/logs', { token: admin, body: {} });
rec('ROB-04', 'Audit log with empty payload accepted (later crashes AuditLogsView?)', '400', r.status, r.status === 201 ? 'FAIL -> see UI-LOG-CRASH' : 'PASS');

r = await call('PUT', `/users/usr-admin`, { token: admin, body: { role: 'Employee' } });
const adminMe = await call('GET', '/auth/me', { token: admin });
rec('USR-05', 'Main Admin demotes THEMSELF to Employee (lock-out risk)', '400 blocked', `PUT ${r.status}, role=${adminMe.json?.role}`, adminMe.json?.role === 'Employee' ? 'FAIL (system can be left with no Main Admin)' : 'PASS');
await call('PUT', `/users/usr-admin`, { token: admin, body: { role: 'Main Admin' } }); // restore attempt (may 403 now)

console.table(out.map(o => ({ id: o.id, title: o.title.slice(0, 62), expected: String(o.expected).slice(0, 26), actual: String(o.actual).slice(0, 44), verdict: o.verdict.slice(0, 52) })));
const tally = out.reduce((a, o) => { const k = o.verdict.split(' ')[0].replace(/[^A-Z-]/g, ''); a[k] = (a[k] || 0) + 1; return a; }, {});
console.log('TALLY', tally);
