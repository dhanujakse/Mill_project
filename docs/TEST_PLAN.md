# Mill Mate (Alagiri Procurement) - Master Test Plan

| | |
|---|---|
| **Product** | Mill Mate / Alagiri Procurement and Logistics System |
| **Version under test** | `main` @ `a087e5e` (working tree clean) |
| **Prepared** | 2026-09-19 |
| **Method** | Static analysis of all ~9.3k lines of source, then black-box probing of an isolated local stack (API and headless browser) to separate *confirmed* defects from *suspected* ones |

**Evidence tags used throughout**

| Tag | Meaning |
|---|---|
| `CONFIRMED-API` | Reproduced by sending real HTTP requests to an isolated test server |
| `CONFIRMED-UI` | Reproduced in a real headless browser (Edge) against the isolated stack |
| `CODE-READ` | Seen in the source with high confidence but **not executed yet** - run the linked test case to confirm |
| `PASS` | Verified to behave correctly |

---

## 1. Scope

### 1.1 System under test
| Layer | Technology | Notes |
|---|---|---|
| Frontend | React 19 + Vite 8 SPA, **hash routing** (`#home`, `#requested-orders?id=..`), mobile-shaped UI | Deployed on Vercel |
| Backend | Express 4 + `node:sqlite` (Node >= 22.5), JWT (30-day), bcryptjs | Deployed on Render |
| Data | SQLite tables: users, requests, suppliers, logs, departments, notifications, settings, whatsapp_messages. Requests and suppliers are stored as **JSON blobs** | Attachments are base64 inside the JSON |
| Mobile | Capacitor 8 Android wrapper (`android/`) | Runtime API URL override in Settings |
| Integrations | Meta WhatsApp Cloud API (send + inbound webhook), n8n outbound webhook | Both optional / env-driven |

### 1.2 In scope
Authentication and sessions, role/permission model, the request lifecycle (create, revise, approve, reject, PO, status workflow, LR and proof uploads, dispatch date, auto-delay engine), suppliers, users, departments, branding, notifications, audit logs, WhatsApp availability flow, webhooks, API contract and security, data integrity and concurrency, performance, compatibility (browsers, devices, Android), deployment (Vercel + Render) and resilience.

### 1.3 Out of scope
Meta/WhatsApp platform internals, Vercel/Render infrastructure SLAs, third-party penetration testing, and load testing beyond the volumes in section 9.

### 1.4 Ground rules (important)
1. **Never run destructive or crash tests against production** (`alagiri-mill.vercel.app` / `mill-project.onrender.com`). BUG-01 below is a one-request server crash.
2. Use the isolated stack in section 2 for anything that writes data.
3. Production is allowed only for read-only smoke checks and the release checklist (section 11).

---

## 2. Test environment and data

### 2.1 Isolated QA stack (throw-away DB, separate ports)
```powershell
# Terminal 1 - backend on :4100 with a disposable database
cd D:\Mill_project\server
$env:DB_PATH="$env:TEMP\qa.db"; $env:PORT="4100"; $env:JWT_SECRET="qa-only-secret"; $env:CORS_ORIGIN="http://localhost:8102"
Remove-Item "$env:TEMP\qa.db*" -ErrorAction SilentlyContinue
node index.js

# Terminal 2 - frontend on :8102 pointing at that backend
cd D:\Mill_project
$env:VITE_BACKEND_URL="http://localhost:4100"; npx vite --port 8102 --strictPort
```
Reset between runs by deleting `qa.db*` and restarting the backend (it re-seeds automatically).
Automated API probe: `node qa/api-probe.mjs` (needs a fresh DB each run; read the header of that file first). **The probe's row IDs (e.g. `SEC-08`, `USR-05`) are its own numbering and are always written as "probe rows" in this document; plan test-case IDs are the ones in the tables below.**

> **Splash screen:** a full-screen overlay covers the UI for roughly the first 5 seconds after load and swallows taps. Wait about 6 s before clicking or automating (see UX-01).

### 2.2 Seed data (created automatically on an empty DB)
| Type | Values |
|---|---|
| Users | `admin` / `Password123!` (Main Admin, "Johnson"); `employee` / `Password123!` (Employee, "Ramesh Kumar") |
| Suppliers | AB Company (sup-1), Vel Automobiles (sup-2), Senthil Fitter (sup-3), Green1 Materials LLC (sup-4, +1 555 number) |
| Departments | Kraft Mill, Maintenance, Production, Utility, Logistics, Executive Office |
| Bill-To / Ship-To | Alagiri Duplex Factory / Office, Alagiri Paper Mill Factory / Office (`src/config.js`) |

### 2.3 Extra accounts to create before testing (Main Admin > Settings > Users)
| Account | Role | Permissions | Purpose |
|---|---|---|---|
| `sub_full` | Sub Admin | all four ticked | Positive permission path |
| `sub_none` | Sub Admin | none ticked | Negative permission path |
| `sub_orders` | Sub Admin | `edit_orders` only | Order-edit isolation |
| `sub_sup` | Sub Admin | `manage_suppliers` only | Supplier isolation |
| `sub_logs` | Sub Admin | `view_logs` only | Log isolation |
| `emp2` | Employee with the **same display name** as `employee` ("Ramesh Kumar") | - | Name-collision test (S-01) |
| `emp_disabled` | Employee, then disabled | - | Disabled-login tests |
| `emp_newpw` | Employee, freshly created (must change password) | - | Forced-password-change flow |

### 2.4 Request data set
| Name | Content |
|---|---|
| REQ-min | 1 product, qty 1, no supplier, no attachment |
| REQ-multi | 3 products (different units), suggested supplier chosen from list, PDF attachment |
| REQ-manual | Suggested supplier typed manually (new name + phone) |
| REQ-old | `date` 10 days in the past, status Pending (create via API, see BUG-02) |
| REQ-legacy | `billTo = "Alagiri Duplex (Unit 1)"` (an old value not in the current list) |
| REQ-big | Attachment of about 9 MB, then 12 MB (limit tests) |
| REQ-unicode | Product with Tamil text, emoji, `<b>`, quotes and 300 characters |

### 2.5 Device / browser matrix
| Class | Targets |
|---|---|
| Desktop | Chrome, Edge, Firefox (latest); Safari 17+ if available |
| Mobile web | Android Chrome, iOS Safari (real devices for camera and file picker) |
| Viewports | 320x568, 375x667, 390x844, 768x1024, 1440x900 |
| Native | Android APK (debug build via `npm run android:apk`), Android 10 and 14 |
| Network | Fast, Slow 3G throttle, offline, offline-then-online |

---

## 3. Roles and permission model under test

| Capability | Employee | Sub Admin | Main Admin |
|---|---|---|---|
| Create / revise own request | yes | yes | yes |
| Approvals list, edit card, Generate PO, Reject | UI: read-only card | UI: **no gate** (see S-03) | yes |
| Change order status, edit dispatch date, Ask Supplier | no (UI hidden) | needs `edit_orders` | yes |
| Verify and mark Received | yes (button shown) | yes | yes |
| Suppliers add / edit | no | needs `manage_suppliers` | yes |
| Audit logs | no | needs `view_logs` | yes (also bulk delete) |
| Users, Departments, Branding/Automation | no | no | yes |
| Notification preferences | no | yes | yes |

Every "no" must be verified **twice**: hidden or redirected in the UI, and rejected by the API with 403 (a hidden button is not a control).

---

## 4. Risk-based priorities

| Rank | Risk | Why |
|---|---|---|
| 1 | Server availability and security (crash on bad input, no throttling, no request authorization) | One request can take the whole system down; data is exposed |
| 2 | Order lifecycle correctness (status engine, auto-delay, PO generation) | This is the business function; silent mis-transitions cost money |
| 3 | Data integrity (full-replace writes, concurrent edits, ID/PO collisions, ephemeral DB on Render) | Loss or corruption of procurement records |
| 4 | Permissions and audit-trail trustworthiness | Auditability is a stated feature |
| 5 | Mobile, deployment and resilience | Real users are on phones and on a free-tier host |
| 6 | Cosmetics and UX | Lowest |

Priority tags in test tables: **P0** must pass before any release, **P1** important, **P2** nice to have, **P3** low / cosmetic.
Severity: **S1** outage / data loss / security breach, **S2** major function broken, **S3** minor function or workaround exists, **S4** cosmetic.

---

## 5. Defects already found during analysis

### 5.1 Confirmed by execution

| ID | Sev | Finding | Evidence | Repro |
|---|---|---|---|---|
| **BUG-01** | **S1** | **A single unauthenticated request kills the API process.** `/auth/login` is an `async` handler in Express 4 and calls `.trim()` on user input; a non-string value throws, the promise rejection is unhandled, and Node exits. The same happens for `PUT /users/:id` with a non-string `name` (any logged-in user, on their own id). Every user is disconnected until the host restarts it, and the attack can be repeated indefinitely | CONFIRMED-API (server log `TypeError: ... .trim is not a function`, then connection refused) | `curl -X POST <api>/auth/login -H "Content-Type: application/json" -d '{"username":123,"password":"x"}'` - **local only** |
| **BUG-02** | **S1/S2** | **A Pending request older than about 3 days silently becomes "Delayed" when anyone opens the app.** The auto-delay routine in `loadProtectedData` only skips Booked/Received/Rejected, so it also processes never-approved requests. The request then vanishes from the Approvals queue, and delay notifications and audit entries are fabricated for an order that was never placed | CONFIRMED-UI (10-day-old Pending was still Pending before admin login, then `Delayed`; a fresh one stayed Pending) | Create a request with `date` 10 days ago via API, log in as admin, re-read the request |
| **BUG-03** | **S1** | **No authorization on `/requests`.** Any authenticated employee can set any status, PO number or supplier on any request via the API, edit other people's requests, and read everyone's requests (the employee filter exists only in the UI) | CONFIRMED-API (probe rows AUTHZ-01/02/03) | Employee token: `PUT /requests/<id>` with `status:"Received"` returns 200 |
| **BUG-04** | **S2** | **No login throttling or lockout.** 25 wrong passwords in 7.5 s, no 429, and the correct login still works afterwards | CONFIRMED-API (probe rows SEC-08/09) | Loop `POST /auth/login` |
| **BUG-05** | **S2** | **The audit trail is forgeable and can be poisoned.** Any user can POST a log with any `userName`/`role`. One malformed row (`POST /logs {}`) makes the **Audit Logs page crash for every admin permanently** (`Cannot read properties of undefined (reading 'toLowerCase')`) | CONFIRMED-API + CONFIRMED-UI | Employee: `POST /logs {}`, then admin opens Settings > Audit Logs |
| **BUG-06** | **S2** | **Notifications are one shared inbox.** Any employee can wipe or mark-read **everyone's** notifications (`DELETE /notifications`, `PATCH /notifications/mark-read` return 204) | CONFIRMED-API (probe rows AUTHZ-08/09) | Employee token on both endpoints |
| **BUG-07** | **S2** | **Server-side validation is weaker than the UI implies.** A bogus role and a nonexistent department are accepted on user create; 1-character passwords are accepted (create, change-password); the phone regex `^(\+91)?\d{10}$` accepts numbers starting with 0 or 1; **Main Admin can demote themselves to Employee**, leaving no admin | CONFIRMED-API (probe rows USR-01/02/04/05, PWD-01) | See `qa/api-probe.mjs` |
| **BUG-08** | **S2** | **Whole-document overwrites.** `PUT /requests/:id` with `{status:"Rejected"}` replaces the entire stored request; `PUT /settings/branding {appName:"X"}` deletes `billingLocations` and all colors. The branding case is the **root cause of the original blank-page report** (an unguarded `billingLocations.map`) | CONFIRMED-API (probe rows DATA-01, SET-01/02) | `PUT` with a single field |
| **BUG-09** | **S3** | The supplier API has no validation (blank name, letters as phone, invalid email all accepted) and a duplicate id returns **500** instead of 409. The webhook URL accepts any scheme (`javascript:`) | CONFIRMED-API (probe rows SUP-01/02, SET-03) | See probe |
| **BUG-10** | **S3** | Error handling: malformed JSON returns **500** (should be 400); a body over 15 MB returns **500** (should be 413); an unknown API route returns an HTML 404 | CONFIRMED-API (probe rows ROB-01/02/03) | See probe |
| **BUG-11** | **S3** | The React error boundary added in `main.jsx` **does not reset on navigation**: after any crash, going to `#home` still shows "Something went wrong" and the bottom nav bar is gone; only its own button recovers | CONFIRMED-UI | Trigger BUG-05, then change the hash |

**Status update (2026-09-20, changes not yet committed):**

| ID | Status | How it was verified |
|---|---|---|
| BUG-01 | **Fixed.** Async routes are wrapped so an unexpected error returns a JSON 500 instead of killing the process, and non-text input to login, password, user create/update and reset-password now returns 400 | 19 crash-vector requests, server stayed up for every one; wrapper proven with a route that throws |
| BUG-02 | **Fixed.** Pending requests are never auto-delayed, and requests already wrongly marked Delayed (never approved) are restored to Pending on the next load | Browser test with 6 order types; second load adds no duplicate history |
| BUG-03, 05, 06, 07, 08, 09, 10, 11 | **Accepted / not planned** - the owner confirmed all roles keep broad access by design (only approving and PO generation are limited to Admin and Sub Admin) | - |
| BUG-04 | Open (no login throttling) | - |

**Verified PASS (keep as regression checks):** missing or garbled token rejected (401); SQL-injection style username rejected; empty password 400; 100 KB password handled; employee blocked from users, suppliers, logs and branding (403); an employee **cannot** escalate their own role through `PUT /users/:id`; duplicate email (case-insensitive) 409; user name / email / short-phone validation; duplicate department 409; HTML in a supplier name is shown as literal text (no XSS).

### 5.2 Suspected from source (execute the linked test case to confirm)

| ID | Sev | Suspicion | Where | Test |
|---|---|---|---|---|
| S-01 | S2 | Employee visibility is keyed on display **name**, not user id. Two employees with the same name see each other's orders; renaming a user orphans their history | `employeeName === user.name` (Live Orders, History, Home) | RBAC-11 |
| S-02 | S3 | Employee Home dashboard counts are **system-wide** while Live Orders is filtered to that employee, so the numbers disagree | `HomeView` `userRequests` | HOME-04 |
| S-03 | S2 | `approve_requests` is a permission checkbox that is **never enforced** in the UI or the API; a Sub Admin without it can still approve and reject | grep: only appears in the user form | RBAC-06 |
| S-04 | S2 | No double-submit guard on Generate PO / Reject. The PO number is `PO-YYYY-<last 6 digits of Date.now()>` (not sequential, no uniqueness constraint) and the request id is `REQ-<Date.now()>` (collides if two are created in the same millisecond) | `handleApprove`, `handleReject` | ORD-12, DATA-05 |
| S-05 | S2 | `handleStatusChange`, LR upload and approve have **no try/catch**: an API failure (offline, or an LR over about 11 MB whose base64 exceeds the 15 MB body limit) gives no user feedback and leaves the UI stale | `OrderDetailsView` | ORD-30, NET-03 |
| S-06 | S3 | The UI password meter lists 4 rules but `isPasswordStrong` only checks length >= 6; every change-password failure (even a network error) is reported as "current password incorrect"; the new password may equal the old one | `isPasswordStrong`, `ChangePasswordForm` | AUTH-15, AUTH-16 |
| S-07 | S3 | After login the app always jumps to `#home`, so deep links such as an order URL are lost | `LoginView onLogin` | AUTH-19 |
| S-08 | S2 | Auto-delay compares **UTC** dates (`toISOString().split('T')[0]`) with locally entered dispatch dates; in IST (UTC+5:30) there is a window between 00:00 and 05:30 local time where "today" is off by one day | `loadProtectedData`, `handleEditDispatchDate` | DELAY-06 |
| S-09 | S3 | Some notifications target role `"Admin"` ("New Request Created", "Request Revised") but the real roles are `Main Admin` / `Sub Admin`; the bell filters `role === "Both" \|\| role === user.role`, so **admins may never see them** | `CreateRequestView` addNotification calls, `HomeView` | NOTIF-03 |
| S-10 | S3 | The n8n webhook payload takes the user name from `CONFIG.users` keyed on the legacy `"Admin"` role, so Main Admin / Sub Admin actions are reported as the mock employee "John Doe" | `triggerWebhook` | HOOK-03 |
| S-11 | S3 | The supplier form is not a `<form>`, so `type="email"` is not validated; a whitespace-only company name passes; there is no phone/GST format check; duplicate company names are allowed | `SupplierForm` | SUP-04 to SUP-08 |
| S-12 | S3 | Legacy `billTo` values not in `BILL_TO_OPTIONS` (old "Unit 1/Unit 2" data) may break Revise/approve selects and PO addresses | `config.js`, approval card | LEG-01 |
| S-13 | S2 | `GET /requests` returns every row including base64 attachments (no pagination), and the auto-delay routine issues sequential PUTs from the **browser** on every load, so two admins loading at once race | `loadProtectedData` | PERF-02, CONC-03 |
| S-14 | S1 | Render free tier: the ephemeral disk wipes SQLite on redeploy unless `DB_PATH` points at a persistent disk; `JWT_SECRET` must be stable; a cold start of 30-60 s shows "Could not reach the server" | deployment | DEP-02 to DEP-05 |
| S-15 | S3 | Audit CSV export is open to formula injection (`=`, `+`, `-`, `@` prefixes) and crashes on non-string fields | `AuditLogsView handleExport` | LOG-06 |
| S-16 | S3 | The WhatsApp inbound classifier `/available/i && !/not\s*available/i` mishandles "unavailable", "n/a", "yes/no" and Tamil replies | `routes/whatsapp.js` | WA-08 |
| S-17 | S3 | The PO's "Authorized Signatory" prints `CONFIG.users.admin.name` (mock config value), not the approving admin | `PoPreviewView` | PO-03 |

---

## 6. Functional test cases

Format: **ID** | scenario and steps | expected result | priority. "Expected" reflects the *intended* behaviour; where the code is known to differ, the suspected/confirmed item is cited.

### 6.1 Authentication and session (AUTH)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| AUTH-01 | Log in as `admin` with the correct password | Lands on `#home`; token stored (`pms_auth_token`); dashboard loads | P0 |
| AUTH-02 | Log in as `employee` | Home shows employee-scoped UI (Request tab, not Approvals) | P0 |
| AUTH-03 | Wrong password for a real user | "Invalid username or password"; no session created | P0 |
| AUTH-04 | Unknown username | **Same** message as AUTH-03 (no user enumeration) | P0 |
| AUTH-05 | Submit with both fields empty | Client message "Please fill in both fields." and no request sent | P1 |
| AUTH-06 | Username/password made only of spaces | Same as AUTH-05 (values are trimmed) | P1 |
| AUTH-07 | `ADMIN`, `Admin` as username | Accepted (case-insensitive, by design) | P2 |
| AUTH-08 | `password123!` (wrong case) | Rejected (password is case-sensitive) | P1 |
| AUTH-09 | Log in as a disabled user (`emp_disabled`) | "Your account is disabled..." (403); no session | P0 |
| AUTH-10 | Admin disables a user **while that user is logged in**; user performs any action | 401 -> "Session Expired" toast -> login screen; no stale data visible | P0 |
| AUTH-11 | Edit `pms_auth_token` in localStorage (corrupt it), reload | Cleanly returns to login; cached user removed | P0 |
| AUTH-12 | Log out; press browser Back | Login screen; no private data reachable; `pms_auth_token` and `pms_current_user` removed | P0 |
| AUTH-13 | Reload while logged in | Session restored via `/auth/me`; current hash preserved | P1 |
| AUTH-14 | Login as `emp_newpw` (must change password) | Forced-change screen; nav bar/other routes unreachable; after change lands on Home | P0 |
| AUTH-15 | Forced/normal change to `aaaaaa` (no upper/number/special) | Meter shows unmet rules; **expected: rejected**. Code accepts length >= 6 (S-06) | P1 |
| AUTH-16 | Change password: wrong current, mismatched confirm, new == current, server offline | Each gives the *correct* message; offline must not say "current password incorrect" (S-06) | P1 |
| AUTH-17 | Eye toggles on password fields | Unmasks on click; re-masks on blur and after submit | P2 |
| AUTH-18 | Log out in tab A, act in tab B | Tab B receives 401 and returns to login; no crash | P1 |
| AUTH-19 | Open `#order-details?id=X` while logged out, then log in | Ideally lands on the requested page; **currently lands on `#home`** (S-07) | P2 |
| AUTH-20 | Admin resets a user's password; user tries the old one | Old password fails; new temp password works then forces change | P0 |
| AUTH-21 | 25+ rapid wrong passwords | Throttle/lockout expected; **none exists** (BUG-04) | P0 |
| AUTH-22 | Login body with numeric/object/array username or password (**local only**) | 400 error; **currently kills the server** (BUG-01) | P0 |
| AUTH-23 | User A logs out, user B logs in on the same browser | No requests, notifications, avatar or cached state of A visible to B | P0 |
| AUTH-24 | Token older than 30 days (set `exp` in the past on a test server) | 401 and clean logout | P1 |
| AUTH-25 | `?reset_db=true` in URL | Clears this browser's session/UI overrides only, never server data | P2 |
| AUTH-26 | Password manager autofill and paste into both fields | Works; no double-submit | P2 |
| AUTH-27 | First-load splash: tap the login button during the first seconds | Documented behaviour (overlay blocks input); see UX-01 | P2 |

### 6.2 Roles and permissions (RBAC)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| RBAC-01 | Compare bottom nav for Employee vs Sub Admin vs Main Admin | Employee: Home/Request/History/Settings; admins: Approvals in place of Request | P0 |
| RBAC-02 | As Employee open `#settings/users`, `/departments`, `/branding`, `/logs`, `/suppliers`, `/notifications` by typing the hash | Each redirects to `#settings` | P0 |
| RBAC-03 | Repeat RBAC-02 for `sub_none`, `sub_orders`, `sub_sup`, `sub_logs`, `sub_full` | Only routes matching their permissions open; users/departments/branding always denied | P0 |
| RBAC-04 | API matrix: call every endpoint with each role's token (script it) | Status codes match section 3 exactly (403 where denied) | P0 |
| RBAC-05 | `sub_none`: Settings screen | No Suppliers / Logs entries shown | P1 |
| RBAC-06 | `sub_none` (approve_requests unticked) opens Approvals, edits, Generate PO, Reject | **Expected: blocked.** Code has no gate (S-03) | P0 |
| RBAC-07 | `sub_orders` vs `sub_none` on Order Details | Only `sub_orders` sees Change status, dispatch-date edit and Ask Supplier | P0 |
| RBAC-08 | `sub_sup` adds/edits a supplier; `sub_logs` opens logs | Allowed; `sub_logs` has no delete/select controls (Main Admin only) | P1 |
| RBAC-09 | Try to disable/delete the Main Admin in UI and via API | Refused in both ("Main Admin cannot be disabled/deleted") | P0 |
| RBAC-10 | Admin changes a logged-in Sub Admin's permissions | API enforces immediately (DB is read on each request); UI updates after refresh - record the lag | P1 |
| RBAC-11 | `employee` and `emp2` share a display name; each creates a request | Each sees only their own; **suspected: they see each other's** (S-01) | P0 |
| RBAC-12 | Rename a user who has existing requests | Their history stays theirs (key on id, not name) | P1 |
| RBAC-13 | Main Admin demotes self / last admin changes role | Blocked ("at least one Main Admin"); **currently allowed** (BUG-07) | P0 |
| RBAC-14 | Employee calls `PUT /requests/<other user's id>` and `GET /requests` | 403 and own-only list; **currently 200 and everything** (BUG-03) | P0 |
| RBAC-15 | Employee `PUT /users/<own id>` with `role`, `permissions`, `disabled` | Fields ignored; role unchanged (PASS: probe row SEC-10) | P0 |

### 6.3 Home dashboard (HOME)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| HOME-01 | Compare every card count with the matching list | Numbers equal list lengths (Requested = Pending + Rejected, per code; confirm this is intended) | P0 |
| HOME-02 | Coloured chips: No Response (red), Acknowledged (orange), Booked (blue) always shown; Received (green) and Delayed (yellow) only when > 0 | As described | P2 |
| HOME-03 | A Received order older than 14 days | Disappears from Live counts, appears in History | P1 |
| HOME-04 | Employee with own and others' orders | Home counts equal the employee's own Live Orders numbers (**suspected mismatch**, S-02) | P1 |
| HOME-05 | Bell: unread dot, open list, "Clear All" | Unread dot clears on open; Clear All empties list and shows toast | P1 |
| HOME-06 | Smart View entries | Each opens Live Orders on the right tab via `?filter=` | P1 |
| HOME-07 | Avatar tap | Opens Settings | P2 |
| HOME-08 | Counts after approve/reject/status change without reloading | Update immediately | P0 |
| HOME-09 | Soft-deleted (removed-from-view) orders | Excluded from that user's counts only | P1 |
| HOME-10 | Logo image missing (rename `public/millmate-logo.png` temporarily) | Alt text or graceful fallback, no layout break | P3 |
| HOME-11 | Safe-area padding on notched phones and Android status bar | Header not clipped | P2 |

### 6.4 Create / revise request (REQ)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| REQ-01 | Minimal valid: name, qty 1, Bill To, Ship To | Created as **Pending**; toast; id `REQ-<ts>`; history "Initial request placed." | P0 |
| REQ-02 | Empty product name; then spaces only | "Product Name is required."; not submitted | P0 |
| REQ-03 | Qty: empty, 0, -5, 0.5, 1e3, 99999999999, `abc` (paste) | Empty/0/negative rejected with message; decimals per business rule; huge values do not break layout | P0 |
| REQ-04 | Units: every option; datalist values | Saved and shown identically in PO and lists | P1 |
| REQ-05 | Add 3 products, delete the **middle** one | Remaining rows keep their own error messages (errors are index-keyed - verify no mix-up); cannot delete the last row | P0 |
| REQ-06 | Multi-product request end-to-end | `items[]` shown in approval card, PO, order details; lists show the primary item - check the others are not silently lost | P0 |
| REQ-07 | Suggest supplier from list | Phone auto-fills from supplier | P1 |
| REQ-08 | "Add Supplier Manually": name only / phone only / both | Both required; phone digits only (spaces, hyphen, `+91` tolerated); letters rejected | P0 |
| REQ-09 | Manual phone of 5 digits or 15 digits | No length rule exists client-side; confirm business rule and WhatsApp impact (WA-03) | P1 |
| REQ-10 | Bill To required; change Bill To | Ship To options depend on Bill To; an invalid old Ship To resets to empty and is required | P0 |
| REQ-11 | Due date in the past, empty, far future | Default is today + 7 days; decide and test the rule for past dates | P1 |
| REQ-12 | Priority values | Stored and displayed consistently | P2 |
| REQ-13 | Attachments allowed: pdf, xls, xlsx, doc, docx, jpg, jpeg, png | Accepted; name shown; removable with the red X | P0 |
| REQ-14 | Attachments blocked: `.exe`, `.html`, `.svg`, `.js`, `a.pdf.exe`, no extension, `A.PDF` (uppercase) | Blocked with "Security Block" toast, except uppercase valid types which must be accepted | P0 |
| REQ-15 | Attachment 5 / 9 / 12 MB | Small OK; oversize gives a clear error, **not a silent failure** (S-05 / BUG-10) | P0 |
| REQ-16 | Scan Document: allow, deny, no camera | Live preview and capture; deny falls back to file input | P1 |
| REQ-17 | Camera image capture (mobile) | Compressed to <= 800 px JPEG; name `Camera_...jpg` | P1 |
| REQ-18 | Voice input (Mic): supported and unsupported browsers | Real recognition when available; documented simulated-text fallback otherwise; Tamil speech | P2 |
| REQ-19 | Double-click / rapid taps on **Place Request** | Exactly one request (isSubmitting guard) | P0 |
| REQ-20 | Server down or 401 during submit | Error toast, form data retained, no partial record | P0 |
| REQ-21 | After submit | Audit log, notification, `request.new` webhook, redirect | P1 |
| REQ-22 | Revise (`#create-request?clone=<id>`) from a No Response order | All fields including multiple items prefilled; only changed fields produce "Field [...] modified" history lines and audit entries | P0 |
| REQ-23 | Revise a request of another employee (API) | Should be denied (BUG-03) | P0 |
| REQ-24 | 5,000-character description; emoji; Tamil; quotes; `<script>` | Stored intact; rendered as text everywhere (list, PO, details, logs, CSV) | P0 |
| REQ-25 | Leave the form half filled, navigate away, return | Document expected behaviour (no draft persistence) | P3 |
| REQ-26 | Two users submit in the same millisecond (scripted) | Distinct ids; **suspected collision** (S-04 / DATA-05) | P1 |

### 6.5 Approvals (APR - Requested Orders)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| APR-01 | Open Requested Orders | Lists Pending (and Rejected with "Re-order Required" badge); count in header | P0 |
| APR-02 | Empty state | "No pending requested orders." | P2 |
| APR-03 | Open a card; use browser Back/Forward; refresh on `?id=` | State and selection restored; unknown id shows "Not Found" with a way back | P1 |
| APR-04 | Edit product, qty, units, description, Bill To, Ship To, transport | Changes persist to the order and produce per-field history + audit entries | P0 |
| APR-05 | Supplier picker: search text, product-match highlighting, ratings, select | Selection fills "Active Supplier"; modal closes | P1 |
| APR-06 | Suggested-supplier banner: Approve Supplier / Change Supplier | Banner hides after choice; matching by company name is case-insensitive | P1 |
| APR-07 | Generate PO with **no supplier chosen** but a manual suggestion | Supplier auto-registered (no duplicate if the name exists in another case) | P0 |
| APR-08 | Generate PO with no supplier and no suggestion | "Validation Error" toast; nothing saved | P0 |
| APR-09 | Set qty to blank / 0 / -3 at approval | Blank and 0 blocked; negative must also be blocked (verify) | P1 |
| APR-10 | Generate PO happy path | Status `No Response`; PO `PO-YYYY-nnnnnn`; `poDate`; history; notification; audit; `request.*` webhook; goes to PO preview | P0 |
| APR-11 | Reject with reason / empty reason / 500 chars / HTML | Empty stores "Denied by management."; status `Rejected`, `wasRejected=true`; redirected Home | P0 |
| APR-12 | Double-click Generate PO; two admins approve the same request at once; approve a request another admin just rejected | Single PO, no overwrite of a newer state; **currently no guard** (S-04, CONC-01) | P0 |
| APR-13 | Employee opens a Pending card | Read-only text view, no editable controls | P0 |
| APR-14 | Sub Admin variants | Per RBAC-06 | P0 |
| APR-15 | Pending count / list refresh after each action | Immediate | P1 |
| APR-16 | Legacy request (REQ-legacy) opened here | Bill To select shows a valid value or an explicit warning, never silently blank (LEG-01) | P1 |

### 6.6 PO preview and WhatsApp share (PO)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| PO-01 | Open PO for a multi-product order | Company, PO no., date, Bill To / Ship To addresses (from `COMPANY_ADDRESSES`), **all** items with qty and description, transport mode, due date | P0 |
| PO-02 | Unknown id in `#po-preview?id=` | Message and a way back (currently plain text only - UX) | P2 |
| PO-03 | "Authorized Signatory" name | Should be the approving admin; **code prints `CONFIG.users.admin.name`** (mock) - verify (S-17) | P1 |
| PO-04 | Share via WhatsApp | Status -> `No Response`, history "PO dispatched to WhatsApp.", notification, audit, chat simulator thread, link opens `api.whatsapp.com/send?phone=..&text=..` | P0 |
| PO-05 | Supplier phone formats: `9876543210`, `+919876543210`, with spaces/hyphens, empty, `+1555...` | Link works or the user is told why not (no country code -> invalid `wa` link) | P0 |
| PO-06 | Message with `& % # + newline`, Tamil, emoji | Correctly URL-encoded and received intact | P1 |
| PO-07 | Pop-up blocked | Status change still consistent and user informed | P1 |
| PO-08 | Reopen the same PO later | Same PO number and content | P1 |
| PO-09 | Print / Save as PDF from browser | Layout not clipped; nothing sensitive missing | P2 |

### 6.7 Live orders (LIVE)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| LIVE-01 | Tabs No Response / Acknowledged / Booked / Received / Delayed | Each shows only its status; tab counts equal card counts | P0 |
| LIVE-02 | Deep link `#live-orders?filter=booked`, `noresponse`, `Delayed`, invalid, mixed case | Correct tab or default; no crash | P1 |
| LIVE-03 | Received tab | Only orders received within 14 days (by `actualDeliveryDate`) | P0 |
| LIVE-04 | Smart search: multiple words (AND), PO number, supplier, description, punctuation, very long, regex characters `( [ *` | Correct filtering; no exception on regex-like input | P1 |
| LIVE-05 | Clear search (X) | Restores list | P2 |
| LIVE-06 | Sort order | Documented (newest first) and stable | P2 |
| LIVE-07 | Employee view | Only own orders (S-01 for same-name users) | P0 |
| LIVE-08 | Card tap vs. "Ask Supplier" button | Button does not also navigate (stopPropagation) | P1 |
| LIVE-09 | Empty tab message | Names the stage, e.g. `No active orders in "No Response" stage.` | P3 |
| LIVE-10 | 500 orders in one tab (data volume) | Scroll smooth; no layout freeze | P2 |

### 6.8 Order details and status workflow (ORD)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| ORD-01 | Open details for each status (No Response, Acknowledged, Booked, Received, Delayed) | Renders without console errors; timeline, supplier, PO link, description, timeline dates correct | P0 |
| ORD-02 | Unknown id; Pending id in URL; during initial loading; on hard reload | "Not Found" or redirect to approvals; loading state; **never a blank page** | P0 |
| ORD-03 | Progress bar and stage labels per status | 0 / 33 / 66 / 100 %, "Order Placed" first | P1 |
| ORD-04 | Change status **forward one step** (Next Stage) | One click, no modal; history entry, audit, notification, webhook | P0 |
| ORD-05 | Move **back** or **Reject** | Modal requires remarks; empty remarks refused ("Remarks are required"); LR can be re-attached | P0 |
| ORD-06 | Skip a stage (No Response -> Received) | Treated as forward or rollback? Confirm rule with business; must not corrupt progress | P1 |
| ORD-07 | Status `Delayed` then change status | Uses last valid non-delayed status as baseline | P1 |
| ORD-08 | "Verify & Mark Received": camera / gallery proof; no proof; cancel | Proof optional or required per business rule; image stored; shown as "Proof of Receipt Attached" | P0 |
| ORD-09 | Received stamps `actualDeliveryDate` | Used by the 14-day rules | P0 |
| ORD-10 | Upload LR copy (pdf/img) on an order | Status becomes Booked; file name in history; LR viewable in modal (image inline, PDF in iframe) | P0 |
| ORD-11 | LR wrong types and sizes (as REQ-14/15) | Blocked / clear error | P0 |
| ORD-12 | Double-click LR upload or status change | Single history entry (no guard exists - S-04) | P1 |
| ORD-13 | Edit expected dispatch date to past / today / future / empty | Past -> `Delayed` (unless Booked/Received/Rejected); future on a Delayed order reverts; empty -> "Please select a valid date." | P0 |
| ORD-14 | Auto-open date prompt for orders without a dispatch date | Appears once, only for edit-permission users | P2 |
| ORD-15 | "Revise" button (top right) | Only for `No Response`; opens prefilled form | P1 |
| ORD-16 | PO access card / "View Purchase Order" link | Opens the right PO | P1 |
| ORD-17 | Timeline attribution ("Updated by") | Real user names; manual vs "System (Auto)" entries distinguishable | P1 |
| ORD-18 | Permission gating (Employee, `sub_none`, `sub_orders`) | Controls hidden/shown per section 3; API rejects the rest | P0 |
| ORD-19 | Two admins change status of the same order | Last write wins silently today; document and test conflict handling (CONC-02) | P1 |
| ORD-30 | Status change / LR upload with the server unreachable | Visible error, UI stays consistent; **no silent failure** (S-05) | P0 |

### 6.9 Rejected orders and history (REJ / HIST)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| REJ-01 | Reject a request, open Rejected Orders | Listed with reason and history; "Re-order Required" badge | P0 |
| REJ-02 | Re-order (revise) a rejected request | Goes back to the flow; badge later shows "Re-ordered - now in Live Orders (status)" | P0 |
| REJ-03 | "Remove from view" (confirm dialog) | Hidden only for that user (`deletedByUserIds`), other users still see it; cancel keeps it | P1 |
| REJ-04 | Employee sees only own rejected orders | As RBAC-14 | P0 |
| HIST-01 | Order History contents | Rejected + Received older than 14 days only | P0 |
| HIST-02 | Search by product / description | Filters; empty message differs for search vs. no data | P2 |
| HIST-03 | Order at exactly 14 days (boundary, +/- 1 minute) | Moves to History at the boundary consistently with Live/Home (single rule) | P1 |

### 6.10 Suppliers (SUP)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| SUP-01 | List with ratings, search in picker | Correct supplier data | P1 |
| SUP-02 | Add supplier with all fields | Saved, immediately selectable in Create/Approvals | P0 |
| SUP-03 | Edit supplier and save | Changes reflected in existing orders' supplier display | P1 |
| SUP-04 | Required-field check: blank; spaces only | Message shown; **spaces-only currently passes** (S-11) | P0 |
| SUP-05 | Email field: `abc`, `a@b`, valid | Invalid formats rejected (not a `<form>`, so browser validation does not run) | P1 |
| SUP-06 | Phone: letters, 5 digits, `+91`, spaces | Validated consistently with users and Create Request | P1 |
| SUP-07 | Duplicate company name (different case) | Warn or block | P1 |
| SUP-08 | GST format (15 chars) | Validate or document as free text | P2 |
| SUP-09 | `<img onerror>` / `<script>` in name, address, remarks | Rendered as text (PASS: no XSS) | P0 |
| SUP-10 | Delete supplier | No delete exists; document (orders keep referencing) | P3 |
| SUP-11 | API: duplicate id | 409 (currently 500 - BUG-09) | P1 |
| SUP-12 | Rating 1-5 | Stars render; stored as integer | P3 |

### 6.11 Users (USR)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| USR-01 | Create Employee / Sub Admin (each permission combo) | Temp password shown once (`Alagiri<username>` when none typed); `mustChangePassword` set | P0 |
| USR-02 | Full name: digits, symbols, empty, 1 char, 100 chars, `O'Brien`, `A-B` | Allowed set is letters, spaces, `.`, `-`, `'`; others rejected in UI and API | P0 |
| USR-03 | Email: invalid, duplicate (case variants), plus-addressing | Format and uniqueness enforced both sides | P0 |
| USR-04 | Phone: `+91` + 10 digits, 10 digits, starts with 0 or 1, 9 or 11 digits | Valid Indian mobile rule (6-9 start) - **API currently accepts 0/1 start** (BUG-07) | P1 |
| USR-05 | Username: duplicate (case), spaces, unicode, very long | Unique case-insensitively; sensible limits | P1 |
| USR-06 | Bogus role or unknown department via API | 400 (currently 201 - BUG-07) | P1 |
| USR-07 | Edit user (self and admin): change name/email/phone/department/avatar | Validation same as create; own edit cannot change role | P0 |
| USR-08 | Disable / enable user | Login blocked / restored; existing session ends (AUTH-10) | P0 |
| USR-09 | Reset password | New temp password; user forced to change on next login; enabled flag set to 1 | P0 |
| USR-10 | Delete user (not Main Admin) | User removed; their old requests keep the display name; document | P1 |
| USR-11 | Non-string `name` on `PUT /users/:id` (**local only**) | 400; currently kills the server (BUG-01) | P0 |
| USR-12 | Permission checkboxes persistence (all four) | Saved, reloaded, enforced (S-03 for approve_requests) | P0 |
| USR-13 | Department renamed, then user shown | Their department follows the rename (transaction) | P1 |
| USR-14 | User in a disabled department | Behaviour documented (can they still log in / be selected?) | P2 |

### 6.12 Departments (DEPT)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| DEPT-01 | Add / rename / toggle disable | Reflected in user forms; duplicate (case/space) -> 409 (PASS) | P1 |
| DEPT-02 | Rename to existing name, to empty, to whitespace | Rejected | P1 |
| DEPT-03 | Rename with special characters (`/`, `?`, `#`, `%`, `&`, Tamil) | URL-encoding works for `/departments/:name` routes | P1 |
| DEPT-04 | Rename does not update `department` already stored **inside requests** | Document as known limitation or fix; verify lists | P2 |
| DEPT-05 | Disable a department that has active users | Defined behaviour, no orphan errors | P2 |

### 6.13 Settings, branding, notifications preferences (SET)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| SET-01 | Branding (Automation panel): app name, colours, company name, billing locations | Applies live; persists after reload for **all** users | P0 |
| SET-02 | Save branding with a field cleared / partial payload via API | Merge or reject; **must not delete billing locations** (BUG-08) | P0 |
| SET-03 | Bad colours (`red`, `#12`, empty) | Validated or ignored, UI stays readable | P2 |
| SET-04 | Webhook URL: empty, invalid, `javascript:`, `http://localhost` | Only http(s) accepted (BUG-09) | P1 |
| SET-05 | API base URL override (Settings) | Saved to localStorage; app uses it; invalid URL gives clear connection error; clearing restores default | P1 |
| SET-06 | Notification preferences toggles | Saved per device (localStorage); confirm what they actually control | P2 |
| SET-07 | Profile / avatar editor: colour, preset icons, upload image, reset | Persists, shown everywhere (home, settings, users list); huge image handled | P1 |
| SET-08 | Change password from Settings | AUTH-15/16 | P0 |
| SET-09 | Logout button | AUTH-12 | P0 |

### 6.14 Audit logs (LOG)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| LOG-01 | Every state-changing action writes a log (create, edit fields, approve, reject, status, LR, dispatch date, webhook, user/permission changes) | Entry with correct user, role, action, previous/updated value | P0 |
| LOG-02 | Search by action / user / details | Filters live | P1 |
| LOG-03 | Select rows, select all, bulk delete with confirmation (Main Admin only) | Only selected rows removed; cancel keeps all; non-Main-Admin has no controls **and API refuses** | P0 |
| LOG-04 | Log with missing fields (`POST /logs {}`) then open the page | Page still renders (skip/label bad rows); **currently crashes** (BUG-05) | P0 |
| LOG-05 | Employee posts a log claiming `userName: admin` | Server stamps the real identity or refuses (BUG-05) | P0 |
| LOG-06 | Export CSV: quotes, commas, newlines, leading `= + - @`, non-string values, 5,000 rows | Valid CSV (BOM present), formulas neutralised, no crash (S-15) | P1 |
| LOG-07 | Log ordering and timezone display | Newest first, local time correct | P2 |

### 6.15 Notifications (NOTIF)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| NOTIF-01 | Each business event creates the right notification (approved, rejected, order placed, status updated, booked, delay) | Correct text, role target, timestamp | P1 |
| NOTIF-02 | Toast auto-dismisses after 4 s; manual X; multiple stacked | No leaks or overlap with modals | P2 |
| NOTIF-03 | "New Request Created" and "Request Revised" | Admins **must** receive them; role `"Admin"` matches nobody (S-09) | P0 |
| NOTIF-04 | Read state is shared across users | Employee opening the bell must not mark admins' items read (BUG-06) | P1 |
| NOTIF-05 | Clear All by one user | Should only affect that user (BUG-06) | P1 |
| NOTIF-06 | Notification body with newlines / HTML | `whiteSpace: pre-line`; HTML shown as text | P1 |

### 6.16 WhatsApp availability flow (WA) - needs Meta sandbox or a stubbed Graph API

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| WA-01 | "Ask Supplier" with **no `META_*` env** | Clear toast ("META_ACCESS_TOKEN is not set..."), no state change, 502 | P0 |
| WA-02 | Ask Supplier as Employee / `sub_none` | Button hidden **and** `POST /whatsapp/ask/:id` returns 403 | P0 |
| WA-03 | Supplier phone normalisation: 10-digit, `91...`, `+91...`, spaces/hyphens, foreign `+1...`, missing | Correct E.164 or a clear "no number" 400 | P0 |
| WA-04 | Successful send (stub) | `supplierAsk` = `awaiting_availability`, message row logged, UI text "WhatsApp sent - awaiting supplier reply" | P0 |
| WA-05 | Ask twice quickly / after reply ("Ask Again") | No duplicate in flight; history preserved or reset by design | P1 |
| WA-06 | Webhook GET verification (`hub.verify_token` right / wrong / missing) | Echoes challenge only when the token matches | P0 |
| WA-07 | Webhook POST signature: valid, wrong, missing header, body altered | Only valid HMAC accepted (403 otherwise); raw-body capture intact | P0 |
| WA-08 | Reply classification: "Available", "not available", "unavailable", "n/a", "yes", "no", Tamil, emoji, quick-reply button | Classified correctly (S-16); unknown replies not silently mis-set | P1 |
| WA-09 | Flow stages: available -> asks for date -> date reply -> `replied` + notification; unavailable -> `replied` | UI text per stage; notification generated; no status auto-change without human confirmation | P0 |
| WA-10 | Two open requests for the same supplier phone | Reply attaches to a defined request (currently most recently updated) - verify and document | P1 |
| WA-11 | Delivery / read receipts posted to the same webhook | Ignored with 200, no errors | P1 |
| WA-12 | 24-hour window: freeform follow-up after the window closed | Handled, error not swallowed | P2 |
| WA-13 | Inbound from an unknown number | Logged only, no request modified | P1 |

### 6.17 Automation webhook (HOOK)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| HOOK-01 | No URL configured | Actions succeed; simulation log only; no toast errors | P1 |
| HOOK-02 | Valid endpoint (use a local echo server) | JSON body has `event`, `timestamp`, `user`, `role`, `data`; success toast and audit entry | P1 |
| HOOK-03 | Payload `user` for Main Admin / Sub Admin | Real user name (**code maps to mock "John Doe"** - S-10) | P1 |
| HOOK-04 | Endpoint 500 / unreachable / slow | Failure toast only; user action not blocked | P1 |
| HOOK-05 | Each event fires once: new, updated, rejected, transit (Booked), delivered (Received), status.changed, supplier.response | Correct `event` names, no duplicates | P1 |
| HOOK-06 | Payload size with base64 attachments | Acceptable or attachments excluded | P2 |

---

## 7. API contract and security tests

### 7.1 Endpoint authorization matrix (verify every cell with each role's token)

| Endpoint | Public | Employee | Sub Admin | Main Admin | Known gap |
|---|---|---|---|---|---|
| `GET /api/health` | yes | yes | yes | yes | - |
| `POST /auth/login` | yes | - | - | - | BUG-01, BUG-04 |
| `GET /auth/me`, `POST /auth/change-password`, `POST /auth/force-change-password` | no | own | own | own | BUG-07 (no password policy) |
| `GET/POST /users`, `POST /users/:id/reset-password`, `DELETE /users/:id` | no | 403 | 403 | yes | BUG-07 |
| `PUT /users/:id` | no | own only | own only | any | BUG-01, BUG-07 |
| `GET/POST /requests`, `PUT /requests/:id` | no | **any** | **any** | any | BUG-03, BUG-08 |
| `GET /suppliers` | no | yes | yes | yes | - |
| `POST/PUT /suppliers` | no | 403 | `manage_suppliers` | yes | BUG-09 |
| `GET /logs` | no | 403 | `view_logs` | yes | - |
| `POST /logs` | no | **any** | any | any | BUG-05 |
| `GET /departments` | no | yes | yes | yes | - |
| `POST/PUT/PATCH /departments...` | no | 403 | 403 | yes | - |
| `GET/POST /notifications`, `PATCH /mark-read`, `DELETE /notifications` | no | **any** | any | any | BUG-06 |
| `GET /settings/branding` | **yes** | yes | yes | yes | by design |
| `PUT /settings/branding`, `PUT /settings/webhook-url` | no | 403 | 403 | yes | BUG-08, BUG-09 |
| `GET /settings/webhook-url` | no | yes | yes | yes | reveals the n8n URL to every user - confirm acceptable |
| `POST /whatsapp/ask/:id` | no | 403 | `edit_orders` | yes | - |
| `GET /whatsapp/inbound` | yes (token) | - | - | - | WA-06 |
| `POST /whatsapp/inbound` | yes (HMAC) | - | - | - | WA-07 |

### 7.2 API and security test cases

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| API-01 | Run the matrix above with 4 tokens (none, employee, sub_none/sub_full, admin) | 401 / 403 / 2xx exactly as documented | P0 |
| API-02 | Every write endpoint with missing body, `null`, `[]`, string, number, nested object, 10 MB, 16 MB | 400 / 413 JSON error, **never a crash or 500** (BUG-01, BUG-10) | P0 |
| API-03 | Every string field with non-string types (number, array, object, boolean, null) | 400; server stays up (use a disposable server; each crash = one bug) | P0 |
| API-04 | Malformed JSON, wrong `Content-Type`, empty body | 400 with JSON error | P1 |
| API-05 | Unknown route / wrong method | 404 / 405 JSON | P3 |
| API-06 | Response shape stability (contract snapshot per endpoint) | No password hashes, no internal fields; user object never contains `password_hash` | P0 |
| SEC-01 | Missing / malformed / tampered / expired JWT; `alg:none`; token for a deleted or disabled user | 401 every time (PASS for the first two) | P0 |
| SEC-02 | Brute force on login and on `change-password` | Rate limit and/or lockout with `Retry-After` (BUG-04) | P0 |
| SEC-03 | SQL injection strings in every text field and in `:id` / `:name` path parameters | No error, no data change (statements are parameterised - PASS for login) | P0 |
| SEC-04 | Stored XSS in every free-text field (product, description, remarks, supplier, department, user name, log details, notification, PO, chat simulator, CSV) | Always rendered as text (PASS for supplier name) | P0 |
| SEC-05 | JSON blobs: unexpected keys (`__proto__`, `constructor`, huge nesting) in request/supplier/branding bodies | Ignored or rejected, no prototype pollution | P1 |
| SEC-06 | Mass assignment on `PUT /requests/:id` (`id`, `status`, `poNumber`, `history`, `employeeName`) | Server-controlled fields not client-settable by employees (BUG-03) | P0 |
| SEC-07 | CORS: allowed origin, disallowed origin, `null` origin, wildcard misconfiguration | Only `CORS_ORIGIN` entries answered; production list contains only the Vercel URL and required native origins | P0 |
| SEC-08 | Security headers (CSP, `X-Content-Type-Options`, `X-Frame-Options`, HSTS via Render/Vercel) | Present on frontend; API returns no `X-Powered-By` version leak (Express default sends it) | P2 |
| SEC-09 | Secrets: `JWT_SECRET` length and uniqueness per environment, `.env` not in git, `server/.env.example` has no real values, seed password changed in production | Verified against repo and Render dashboard | P0 |
| SEC-10 | Default credentials `admin` / `Password123!` and `employee` / `Password123!` on **production** | Must be changed or removed before real use (they are documented in seed code) | P0 |
| SEC-11 | JWT stored in `localStorage` | Accepted risk: any XSS = full takeover; keep SEC-04 strict; consider httpOnly cookie later | P1 |
| SEC-12 | Upload safety: allowed extension but wrong content (rename `.exe` to `.png`), SVG with script inside `data:` URL rendered via `<iframe>` (LR viewer) | Not executable in the app origin; sandbox the iframe or restrict types | P0 |
| SEC-13 | Webhook (WhatsApp) replay of a valid signed body | Idempotent (message id de-duplication) or documented risk | P1 |
| SEC-14 | Log injection / forging (BUG-05) | Server-side identity stamping | P0 |
| SEC-15 | Verbose errors | Generic 500 body (PASS); stack traces only in server log | P2 |

---

## 8. Business-rule engines, data integrity and concurrency

### 8.1 Auto-delay engine (runs in the browser on every app load)

Rule as coded: `expected dispatch date = expectedDispatchDate, or order date + 3 days`; if today (UTC string compare) is after it and status is not Booked/Received/Rejected/Delayed -> becomes `Delayed` (with history, 2 notifications, audit log); a `Delayed` order whose date is now valid reverts to the last non-Delayed status.

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| DELAY-01 | **Pending** request older than 3 days (BUG-02) | Must **not** change; excluded from the engine | P0 |
| DELAY-02 | No Response / Acknowledged order past its date | Becomes Delayed once; exactly one set of notifications and one audit entry | P0 |
| DELAY-03 | Booked / Received / Rejected past date | Never delayed | P0 |
| DELAY-04 | Extend the date of a Delayed order to the future | Reverts to the last valid status with a "restored" history entry | P0 |
| DELAY-05 | Reload 5 times with an already-Delayed order | No duplicate history, notifications or logs | P0 |
| DELAY-06 | Boundary: today == expected date; time between 00:00 and 05:30 IST; DST/timezone change on the test device | Consistent local-date semantics (S-08); order not delayed on its due date | P0 |
| DELAY-07 | Order with no `expectedDispatchDate` (uses date + 3) vs. with one | Correct baseline; set once and stored | P1 |
| DELAY-08 | Two admins open the app at the same moment | Single delay transition, no duplicate notifications (CONC-03) | P1 |
| DELAY-09 | 200 overdue orders on load | Completes in acceptable time; sequential PUTs do not freeze UI (PERF-03) | P2 |
| DELAY-10 | Employee loads the app (not admin) | Engine runs with the employee's token: confirm it should, and that permissions do not block/incorrectly allow | P1 |

### 8.2 Data integrity (DATA)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| DATA-01 | `PUT /requests/:id` with a single field | Merge or reject; never replaces the whole record (BUG-08) | P0 |
| DATA-02 | Request `status` column vs. `data.status` | Always identical after every write path (UI, WhatsApp route, API) | P0 |
| DATA-03 | History append-only: edit history via API | Cannot be truncated or rewritten by non-admins | P1 |
| DATA-04 | Supplier renamed after orders exist | Orders display current supplier; PO number/history unchanged | P1 |
| DATA-05 | Id and PO-number uniqueness under rapid creation (script 20 parallel creates/approvals) | No duplicates; PO numbers unique (DB constraint) | P0 |
| DATA-06 | Currency/number/date formats (en-GB display, ISO storage) across locales | Same value everywhere | P2 |
| DATA-07 | Backup / restore of the SQLite file (WAL mode: copy `.db`, `.db-wal`, `.db-shm` together) | Documented procedure works | P1 |
| DATA-08 | Server restart with data present | Seed does **not** run again; nothing overwritten | P0 |
| DATA-09 | Migration: `whatsapp_messages.twilio_sid` rename on an old DB | Runs once, no error on re-run | P2 |

### 8.3 Concurrency (CONC)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| CONC-01 | Admin A approves while Admin B rejects the same Pending request | One winner, the other is told the state changed (APR-12) | P0 |
| CONC-02 | Two users update status/date/LR of the same order | No lost update without notice (currently last-write-wins) | P1 |
| CONC-03 | Two clients run the auto-delay routine simultaneously | Idempotent result (DELAY-08) | P1 |
| CONC-04 | Stale UI: user A's screen after user B changes data | Documented: no polling, refresh required; consider a refresh-on-focus | P2 |
| CONC-05 | Same user logged in on two devices, edits on both | Latest wins, no corruption | P2 |

### 8.4 Legacy data (LEG)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| LEG-01 | Request with `billTo = "Alagiri Duplex (Unit 1)"` opened in Approvals, Revise, PO | Sensible display, no blank select, PO address falls back safely (S-12) | P1 |
| LEG-02 | Old branding row without `billingLocations` (BUG-08) | App loads; no blank page (guards in place, verify all screens) | P0 |
| LEG-03 | Requests without `items[]`, `shipTo`, `history`, `expectedDispatchDate`, `supplierId` | Every screen renders (Live, Details, PO, History, Rejected) | P0 |
| LEG-04 | Request with `date` invalid / missing | No `Invalid Date` crash; sorted sensibly | P1 |

---

## 9. Non-functional tests

### 9.1 Performance and volume (PERF)

Volumes: 1,000 requests, 200 suppliers, 20,000 logs, 500 notifications, 30% of requests carrying a 2 MB attachment.

| ID | Scenario / steps | Target | Pri |
|---|---|---|---|
| PERF-01 | Cold load after login with the volumes above | Interactive < 5 s on 4G | P1 |
| PERF-02 | `GET /requests` payload size and time (S-13) | Report size; if > 5 MB recommend pagination and attachments fetched on demand | P1 |
| PERF-03 | Auto-delay with many overdue orders | UI responsive; failures reported | P2 |
| PERF-04 | Audit logs page with 20,000 rows; CSV export | No freeze; export completes | P2 |
| PERF-05 | Live Orders search typing with 1,000 orders | No lag per keystroke | P2 |
| PERF-06 | JSON body 15 MB: server memory and event-loop | Stable, other requests still served | P1 |
| PERF-07 | 50 concurrent logins (bcrypt cost 10) | Acceptable latency; no timeouts (Render free CPU) | P2 |
| PERF-08 | Frontend bundle (~390 kB, 102 kB gzip) and asset caching | Hashed assets cached; `index.html` not cached long (see DEP-06) | P2 |

### 9.2 Usability, accessibility and UI (UX / A11Y)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| UX-01 | Splash overlay: duration, skippable?, blocks taps for ~5 s | Documented/acceptable; not blocking on slow reloads; not shown again on in-app navigation | P2 |
| UX-02 | Every validation message: wording, position, clears on fix | Consistent tone; focus goes to first error | P2 |
| UX-03 | Toast wording: error toasts use type `"success"` styling in code for many failures | Errors look like errors (colour/icon) | P2 |
| UX-04 | Empty states, loading states, "Not Found" states on every screen | Present, with a way back | P2 |
| UX-05 | Confirmation on destructive actions (reject, remove, bulk delete, disable, reset password) | Clear wording, cancel works | P1 |
| UX-06 | Browser Back / Forward, refresh on each route, opening a route in a new tab | Predictable, no dead ends | P1 |
| UX-07 | Long words / 300-char names / Tamil text in cards, PO, tables | No overflow beyond the card; wraps or truncates with ellipsis | P2 |
| A11Y-01 | Keyboard-only: tab order, Enter/Space on cards (clickable `div`s), Esc closes modal | Operable, visible focus | P2 |
| A11Y-02 | Screen reader labels for icon-only buttons (bell, avatar, back, close, eye) | Accessible names present | P2 |
| A11Y-03 | Colour contrast (orange on cream, white on yellow "Delayed" chip, status badges) | WCAG AA for text | P2 |
| A11Y-04 | 200% zoom and large system font | Layout usable | P3 |
| UI-01 | 5 viewports x 6 key screens (Home, Create, Approvals, Live, Details, Settings) | No horizontal scroll, no clipped buttons, bottom nav never covers content | P1 |
| UI-02 | Light/dark OS mode, landscape orientation, on-screen keyboard covering inputs | Usable | P3 |
| UI-03 | Branding colours changed to extreme values | Text remains readable | P3 |

---

## 10. Compatibility, mobile, network and deployment

### 10.1 Android (Capacitor) (MOB)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| MOB-01 | Install debug APK; first launch with and without network | Splash, login, clear error offline | P0 |
| MOB-02 | API base URL override to production / staging / wrong URL | Works / works / clear error; persists across restarts | P0 |
| MOB-03 | Origin `https://localhost` / `capacitor://localhost` in `CORS_ORIGIN` | Native app calls succeed; other origins blocked | P0 |
| MOB-04 | Hardware Back button on every screen and with a modal open | Navigates back logically; does not exit unexpectedly or leave a stuck modal | P1 |
| MOB-05 | Camera permission allow / deny / "don't ask again", gallery picker, file picker for LR/PDF | Handled with messages; fallback works | P0 |
| MOB-06 | Large photo (12 MP) as attachment/proof | Compressed; no out-of-memory; upload succeeds or fails cleanly | P1 |
| MOB-07 | Rotate, background/foreground for 10 min, kill and relaunch | Session and routing restored | P1 |
| MOB-08 | WhatsApp link opening (`api.whatsapp.com`) with WhatsApp installed / not | Opens app or browser, status logic intact | P1 |
| MOB-09 | Keyboard covering inputs, safe-area (notch, gesture bar) | Fields visible; nav bar not overlapped | P1 |
| MOB-10 | `usesCleartextTraffic` / HTTPS only to Render; certificate errors | Only HTTPS in production build | P0 |
| MOB-11 | Verify APK with `scripts/verify_apk.ps1`; icon and splash assets | Passes | P2 |

### 10.2 Network and resilience (NET)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| NET-01 | Login with server down | "Could not reach the server..." (PASS text exists) | P0 |
| NET-02 | Slow 3G: every primary action (submit, approve, upload) | Loading state, no double submit, no duplicate records | P0 |
| NET-03 | Go offline just before: status change, LR upload, approve, reject, add supplier | Visible error and unchanged data (S-05) | P0 |
| NET-04 | Server returns 500 for `GET /requests` during load | Message and retry; not an endless "Loading..." | P1 |
| NET-05 | Offline then online again | App recovers without reload or clearly asks for it | P2 |
| NET-06 | Render cold start (30-60 s) on first request | Spinner/message, login works on retry, no logout | P1 |
| NET-07 | Non-JSON proxy error page (502/504 HTML) | Handled as a generic error | P1 |
| NET-08 | Optimistic UI: notification/log writes fail | Main action still completes; failure only logged | P2 |

### 10.3 Deployment (DEP) - Vercel + Render

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| DEP-01 | Compare the deployed JS bundle hash/content with the latest `main` build (the earlier blank-page bug was a **stale Vercel deploy**) | Same commit; add a build id in the UI footer or `/version.json` | P0 |
| DEP-02 | Render **persistent disk** and `DB_PATH` | DB survives redeploy/restart; otherwise all data is lost (S-14) | P0 |
| DEP-03 | Env vars on Render: `JWT_SECRET` (stable), `CORS_ORIGIN` (Vercel URL), `META_*`, `PORT`; Vercel: `VITE_API_BASE_URL` | Set, no trailing-slash or scheme mistakes | P0 |
| DEP-04 | Changing `JWT_SECRET` | All sessions invalid -> users see login, no blank page | P1 |
| DEP-05 | Node version on Render >= 22.5 (`node:sqlite`) | Boots; experimental warning acceptable | P0 |
| DEP-06 | Vercel SPA behaviour and caching: direct open of `/#order-details?id=..`, reload, `index.html` cache headers after a new deploy | Users get the new build without hard refresh | P1 |
| DEP-07 | Crash recovery: kill the API process (local) | Supervisor restarts it; time to recover measured (BUG-01) | P1 |
| DEP-08 | Health check endpoint wired to Render health checks | Restarts unhealthy instance | P2 |
| DEP-09 | Logs: errors visible in Render logs, no secrets or passwords logged | Verified | P1 |
| DEP-10 | Free-tier idle spin-down | Documented; consider a keep-alive or paid plan for production | P2 |

### 10.4 Browser compatibility (COMPAT)

| ID | Scenario / steps | Expected | Pri |
|---|---|---|---|
| COMPAT-01 | Full smoke suite (section 11) on Chrome, Edge, Firefox, Safari, Android Chrome, iOS Safari | Identical behaviour | P1 |
| COMPAT-02 | `input type=date`, `type=file capture`, `SpeechRecognition`, `getUserMedia`, `Blob` download (CSV) | Works or degrades gracefully per browser | P1 |
| COMPAT-03 | Private mode / storage blocked (`localStorage` throws) | App still loads (login screen), clear message | P2 |
| COMPAT-04 | Bidi/RTL, Tamil font rendering | Legible | P3 |

---

## 11. Smoke suite and release checklist

### 11.1 15-minute smoke (run after **every** deploy, on the isolated stack first, then read-only on production)

1. Open the app, wait past the splash, log in as admin. Home counts render.
2. Employee: create a request with 2 products, an attachment, and a manual supplier.
3. Admin: Approvals shows it; open, pick a supplier, Generate PO, PO preview shows all items.
4. Share via WhatsApp (link opens) -> order appears in Live Orders / No Response.
5. Order Details: Acknowledged -> upload LR (Booked) -> Verify and mark Received with a proof photo.
6. Reject a second request with a reason; it appears in Rejected Orders; re-order it.
7. Settings: add a supplier, create a user, change own password, view audit logs, export CSV.
8. Log out; log in as the disabled user (must fail); open a protected hash while logged out.
9. Hard-reload on `#order-details?id=<id>` while logged in: page renders (no blank screen).
10. Check the browser console: no errors during steps 1-9.

### 11.2 Release gate (all must be true)

| # | Gate |
|---|---|
| 1 | Zero open S1 defects; BUG-01, BUG-02, BUG-03 closed and retested |
| 2 | Zero open S2 defects **in the flows touched by the release**; others have an owner and date |
| 3 | Smoke suite passes on Chrome desktop and Android Chrome, plus APK if a mobile release |
| 4 | Deployed bundle hash matches the release commit (DEP-01) |
| 5 | Production env checklist (DEP-02, DEP-03, SEC-09, SEC-10) ticked |
| 6 | Regression pack (all P0 cases in section 6-8) executed on the release candidate |
| 7 | No new console errors; error boundary shows a recoverable screen (BUG-11 fixed) |

---

## 12. Execution, reporting and exit criteria

### 12.1 Suggested order of execution
1. **Day 1 - security and stability:** section 7 (API/security) on a disposable server, BUG-01 through BUG-11 reproduction and retest after fixes.
2. **Day 2 - business core:** sections 6.4 to 6.9 and 8.1 (request lifecycle, PO, Live Orders, status engine, auto-delay).
3. **Day 3 - administration:** 6.1, 6.2, 6.10 to 6.15 (auth, roles, suppliers, users, departments, settings, logs, notifications).
4. **Day 4 - integrations and data:** 6.16, 6.17, 8.2 to 8.4.
5. **Day 5 - environment:** sections 9, 10 (performance, mobile, network, deployment), then the smoke suite on the release candidate.

### 12.2 Defect report template
`ID | Title | Severity | Priority | Environment (browser/device/build hash) | Preconditions and data | Steps | Expected | Actual | Evidence (screenshot / console / network / server log) | Frequency | Workaround`

### 12.3 Exit criteria
- 100% of P0 cases executed, 95% pass, and every failure has an accepted defect.
- 90% of P1 executed.
- No open S1; no more than 3 open S2 with mitigation.
- Defect discovery rate in the last cycle < 1 new S2+ per 50 executed cases.

### 12.4 Metrics to report
Cases planned / executed / passed / failed / blocked per module; defects by severity and module; reopen rate; mean time to fix; environment issues separated from product defects.

---

## 13. Automation roadmap

| Priority | What | Tooling |
|---|---|---|
| 1 | API contract and authorization matrix (section 7) - already started in `qa/api-probe.mjs` | Node script or Vitest + supertest; one fresh DB per run |
| 2 | Smoke suite (11.1) | Playwright (wait for the splash; use `data-testid` attributes - none exist today, so tests rely on labels) |
| 3 | Auto-delay engine unit tests | Extract the routine from `App.jsx` into a pure function, then Vitest with fake timers and timezone matrix (UTC, IST, PST) |
| 4 | Visual regression on 5 viewports | Playwright screenshots |
| 5 | Nightly run against a staging Render service | GitHub Actions; publishes the report; never against production |

### 13.1 Testability requests to the developers
- Add `data-testid` to primary buttons/inputs and a `/version` endpoint or build id shown in Settings.
- Make the splash skippable or disabled via a query flag in test builds.
- Separate the test database and secrets (`.env.qa`) so tests never touch real data.
- Return JSON errors for every failure path (BUG-10) so tests can assert on messages.

---

## Appendix A - Reproduction snippets (local isolated server only)

```powershell
# BUG-01: unauthenticated crash (server process exits)
curl.exe -X POST http://localhost:4100/api/auth/login -H "Content-Type: application/json" -d "{\"username\":123,\"password\":\"x\"}"

# BUG-03: employee sets an arbitrary status on any request
$t = (curl.exe -s -X POST http://localhost:4100/api/auth/login -H "Content-Type: application/json" -d "{\"username\":\"employee\",\"password\":\"Password123!\"}" | ConvertFrom-Json).token
curl.exe -X PUT http://localhost:4100/api/requests/<id> -H "Authorization: Bearer $t" -H "Content-Type: application/json" -d "{\"status\":\"Received\"}"

# BUG-05: poison the audit log (then open Settings > Audit Logs as admin)
curl.exe -X POST http://localhost:4100/api/logs -H "Authorization: Bearer $t" -H "Content-Type: application/json" -d "{}"

# BUG-02: create an old Pending request (as employee), then log in as admin in the UI and re-read it
$old = (Get-Date).AddDays(-10).ToUniversalTime().ToString("o")
curl.exe -X POST http://localhost:4100/api/requests -H "Authorization: Bearer $t" -H "Content-Type: application/json" -d "{\"id\":\"REQ-OLD-1\",\"employeeName\":\"Ramesh Kumar\",\"date\":\"$old\",\"productName\":\"Old item\",\"qty\":1,\"units\":\"Pieces\",\"status\":\"Pending\",\"history\":[]}"
```

## Appendix B - What was verified while preparing this plan

| Area | Result |
|---|---|
| Rows executed against the isolated stack (API probe) | 47 checks: 19 pass, 22 fail (each mapped to a defect above), 6 informational / minor |
| Browser checks (headless Edge, 420 px wide) | LOGIC-01 confirmed (BUG-02); Audit Logs crash confirmed (BUG-05); error boundary persistence confirmed (BUG-11); HTML in supplier name safe; approval-card Bill-To list matches Create Request for new data (legacy data still to test, LEG-01) |
| Not executed | WhatsApp (needs Meta sandbox), Android APK, real-device camera, cross-browser matrix, performance volumes, production environment checks |
| Test method caveat | One batch of my own API checks was invalidated because an earlier test demoted the admin account; those rows were re-run on a fresh database and only the re-run results are reported |

