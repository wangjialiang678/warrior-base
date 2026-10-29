# Warrior Base v0.1 contract

Stack: Node 22.13+ Express + node:sqlite, React/Vite. Single-instance deployment behind an HTTPS reverse proxy; see [DEPLOY.md](DEPLOY.md) for the reference topology. Coordinate file ownership for any new parallel implementation.

All JSON errors `{error: string, code?:string}`. Browser same origin `/api`. JSON write routes require exact allowed Origin; server sessions in HttpOnly cookies (Secure production), persisted and revocable. Fetch credentials same-origin. Local demo explicit LOCAL_DEMO=1 only accepted outside production and loopback listening. No seeded fake users in production. Public user fields only id,nickname,avatarId optional. Private `/me` also username,role,phoneMasked. No phone returned publicly.

## Core fields

Work `{id,userId,nickname,lesson,title,description,url,coverId,status,likes,liked,createdAt,updatedAt,isDemo}` public shape. lesson integer1-3. status published/pending/rejected/draft/hidden. Public getters ONLY currently approved version. Owner getters also `pendingVersion` and `moderationReason`, may return hidden/draft. Maintain one work per user/lesson; edits keep previous public version until approved, hide immediate; stale moderation callback must not republish hidden versions. Nickname editing must undergo same moderation or reject/pending without overwriting public. URL from configured deployment domain allowlist, HTTPS only/no auth/port/IP/local; checks do not fetch arbitrary external pages in request handlers.

Settings `{officialAccountName,officialQrId,groupName,groupQrId,groupExpiresAt,groupEnabled,announcement}`; QR images admin uploaded only. Expired/disabled group image not returned publicly. Never pretend QR configured if null.

## Endpoints

- GET `/api/health` -> `{ok,mode:'local-demo'|'live',moderationReady:boolean}`
- GET `/api/me` -> `{user:null|{id,username,nickname,role,phoneMasked},mode,moderationReady}`
- POST `/api/auth/register` `{username,password,nickname,phone,remember:true}` -> `{user}` auto session
- POST `/api/auth/login` `{username,password,remember:true}` -> `{user}`
- POST `/api/auth/logout` -> `{ok:true}`
- POST `/api/auth/recover` `{username,phone,newPassword}` -> `{ok:true}`; user accepted weak phone match, no SMS; deny admins; exact username + phone match prevents shared guardian phone ambiguity; rate limit; revoke all sessions. No username/phone enumeration endpoint.
- GET `/api/works?lesson=1&q=text&page=1` -> `{works,total,page,pageSize}`; optional lesson, default all; defaults newest first, not likes.
- GET `/api/works/:id` -> `{work}`; public only
- GET `/api/profiles/:id` -> `{profile:{id,nickname},works}` public only
- GET `/api/mine` -> `{works}` authenticated owner records
- POST `/api/works` `{lesson,title?,description?,url,coverId?,publish:true,consent:true}` -> `{work,message}`; publish false saves draft and does not make public. Unique own lesson conflict 409 (UI then edits).
- PUT `/api/works/:id` same fields excluding lesson -> `{work,message}`; preserve existing approved public version while new pending; audit limits text/images, immutable snapshot.
- POST `/api/works/:id/hide` -> `{ok:true}` owner or admin
- POST `/api/works/:id/like` `{liked:boolean}` -> `{likes,liked}` authenticated, no self-vote, unique, published only
- POST `/api/works/:id/report` `{reason:'link'|'content',detail?:string}` -> `{ok:true}` limited anonymous report; basic record for review, do not auto-hide by report count.
- POST `/api/uploads` raw PNG/JPEG/WebP bytes with matching Content-Type -> `{id}` authenticated. max2MB, sharp decode/reencode max16MP strip metadata -> private disk media. <=1 optional cover per work, no SVG. Scope ownership on references; bounds on unused uploads. Client sends actual File, not multipart.
- GET `/api/media/:id` -> image only if referenced by published work/current visible settings, or owner/admin; no express static data folder.
- PATCH `/api/profile` `{nickname,avatarId?}` -> `{user,message}`; ownership and moderation apply.
- GET `/api/settings` -> `{settings}` public safe QR metadata only
- GET `/api/admin/overview` -> `{stats:{users,works,pending,reports},works,reports,moderationReady,mode}` admin only; works include status/reason, bounded recent items.
- PUT `/api/admin/settings` settings -> `{settings}` admin only
- POST `/api/admin/works/:id/review` `{action:'approve'|'hide'}` -> `{ok:true}` authenticated admin; live manual approval explicit decision, never called by background without moderation. Restore/hide use newest review target and cannot leak unapproved stale images. Admin approval allowed as exceptional manual override, not user review default.

## Moderation boundary

Production defaults fail-closed: without configured provider new published request becomes pending with clear '自动审核尚未配置，作品已保存，暂未公开'. No fake AI checks marketed as real. Define small HTTP adapter configured MODERATION_URL and token from env, timeout and strict structured result allow/reject/review. Send immutable submitted text and inline image bytes. Provider covers only onsite nickname/title/description and uploaded images; `policy.externalHomepage=false`. No remote page fetch or external-link coverage requirement. Response must explicitly cover text and any supplied image, otherwise review pending. Links remain subject to server-side HTTPS/domain validation. Local demo can allow only with prominent '本机演示，未启用真实 AI 审核' and isolated data. Obvious spam rules/rate limits run before provider. No notifications. Live external moderation must not contact provider until explicitly configured; no credentials checked in.

Admin bootstrap CLI `node server/admin.js create <username>` prompt password/phone? admin NO phone recovery; use terminal secret input or env ADMIN_PASSWORD loaded only locally, not in args, never default password. `npm run dev` may create local demo admin automatically only if credentials printed as explicit demo, but prefer separate CLI root implements docs.

UI routes: `/` gallery; `/works/:id`; `/people/:id`; `/mine`; `/submit?lesson=N`; `/login` with registration/recovery tabs; `/community`; `/admin`. Can use client pathname/history routing (no added router package) with working refresh fallback. Draft entered before auth must survive login but never store passwords/phone in browser storage. Need clear consent unchecked before publish. No frontend-only permission claims.
