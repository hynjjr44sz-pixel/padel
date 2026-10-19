-- Club accounts (D1 database "padel"). Applied by deploy.sh: npx wrangler d1 execute padel --remote --file schema.sql
-- Every row belongs to an organisation (org), so more clubs or academies can live in the same database later.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL DEFAULT 'nynas',
  name TEXT NOT NULL,
  pid INTEGER,                                  -- RankedIn player id (a club player), or null
  created INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS users_pid ON users(org, pid) WHERE pid IS NOT NULL;
-- admin, arr (arrangör); later tranare, foralder
CREATE TABLE IF NOT EXISTS roles (
  user TEXT NOT NULL,
  org TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (user, org, role)
);
-- a logged-in phone: only the SHA-256 of its token is stored
CREATE TABLE IF NOT EXISTS devices (
  hash TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  label TEXT,
  created INTEGER NOT NULL,
  seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_user ON devices(user);
-- one-time invite links: only the SHA-256 of the code is stored
CREATE TABLE IF NOT EXISTS invites (
  hash TEXT PRIMARY KEY,
  user TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  used INTEGER
);
CREATE INDEX IF NOT EXISTS invites_user ON invites(user);
-- who did what (admin changes, logins), for the owner
CREATE TABLE IF NOT EXISTS log (
  at INTEGER NOT NULL,
  org TEXT NOT NULL,
  user TEXT,
  act TEXT NOT NULL,
  detail TEXT
);
-- access requests from the app: the requesting phone shows a code; the admin types it in to approve (only hashes stored)
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  pid INTEGER,                                  -- the club player it is about (own profile, or the child's for a parent)
  name TEXT NOT NULL,
  parent INTEGER NOT NULL DEFAULT 0,            -- 1: a parent asking for a junior
  msg TEXT,
  label TEXT,
  code TEXT NOT NULL,                           -- SHA-256 of the code the phone shows
  wait TEXT NOT NULL,                           -- SHA-256 of the phone's secret (it collects the login with it)
  created INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',          -- open, ok (approved, not yet collected), done, no
  tries INTEGER NOT NULL DEFAULT 0,
  user TEXT
);
CREATE INDEX IF NOT EXISTS requests_org ON requests(org, status);
-- a parent's account and the junior(s) it looks after
CREATE TABLE IF NOT EXISTS guardians (
  user TEXT NOT NULL,
  pid INTEGER NOT NULL,
  PRIMARY KEY (user, pid)
);
-- "Begär konto": at most a few requests a day from one network (the address only as a salted hash)
CREATE TABLE IF NOT EXISTS reqlimit (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reqlimit_ip ON reqlimit(ip, at);
-- passkeys (Face ID / Touch ID): the admin logs in without a link. Only ES256; the public key as SPKI (base64url)
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,                          -- the credential id (base64url)
  user TEXT NOT NULL,
  spki TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  created INTEGER NOT NULL,
  used INTEGER
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user);
-- a passkey challenge: once, for 5 minutes (user: the account adding a passkey; null for a login)
CREATE TABLE IF NOT EXISTS pkchal (
  ch TEXT PRIMARY KEY,
  user TEXT,
  at INTEGER NOT NULL
);
-- Träning: a coach (tranare) or an external PT sees and plans for the players the admin links them to
CREATE TABLE IF NOT EXISTS coaching (
  user TEXT NOT NULL,
  pid INTEGER NOT NULL,
  PRIMARY KEY (user, pid)
);
-- a training session logged by the player (or a parent, a coach): minutes x RPE (1-10) = the session's load
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  pid INTEGER NOT NULL,
  day TEXT NOT NULL,                            -- YYYY-MM-DD
  kind TEXT NOT NULL,                           -- padel, match, gym, lop, pt, fys, annat
  min INTEGER NOT NULL,
  rpe INTEGER NOT NULL,
  note TEXT,
  by TEXT,                                      -- the account that logged it
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_pid ON sessions(pid, day);
-- Träning, fas 2: a head coach's (tranare) training groups, assistant coaches, the shared exercise library, plans
CREATE TABLE IF NOT EXISTS tgroups (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  owner TEXT NOT NULL,                          -- the coach who made it
  name TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tgroup_members (
  gid TEXT NOT NULL,
  pid INTEGER NOT NULL,
  PRIMARY KEY (gid, pid)
);
-- a coach's assistants (e.g. older players): the library and the groups' plans, not the players' own training
CREATE TABLE IF NOT EXISTS assistants (
  coach TEXT NOT NULL,
  user TEXT NOT NULL,
  PRIMARY KEY (coach, user)
);
CREATE TABLE IF NOT EXISTS exercises (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  cat TEXT NOT NULL,                            -- slag, ovningar, strategi, fys
  topic TEXT,
  title TEXT NOT NULL,
  body TEXT,
  yt TEXT,                                      -- a YouTube video id
  level TEXT,                                   -- alla, nyborjare, medel, avancerad
  min INTEGER,
  by TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
-- a planned session for a group or one player; ex: JSON list of exercise ids
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  gid TEXT,
  pid INTEGER,
  day TEXT NOT NULL,
  time TEXT,
  kind TEXT NOT NULL,
  min INTEGER NOT NULL,
  title TEXT NOT NULL,
  note TEXT,
  ex TEXT,
  by TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plans_gid ON plans(gid, day);
CREATE INDEX IF NOT EXISTS plans_pid ON plans(pid, day);
-- a planned session done: the player's logged session (its minutes, RPE and note are the feedback)
CREATE TABLE IF NOT EXISTS plan_done (
  plan TEXT NOT NULL,
  pid INTEGER NOT NULL,
  session TEXT NOT NULL,
  PRIMARY KEY (plan, pid)
);
-- Träning: a thread on a logged session (the coach answers, the player answers back) and the player's stars for it
CREATE TABLE IF NOT EXISTS tcomments (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  session TEXT NOT NULL,
  pid INTEGER NOT NULL,
  by TEXT NOT NULL,
  name TEXT,
  text TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tcomments_session ON tcomments(session, at);
CREATE TABLE IF NOT EXISTS srate (
  session TEXT PRIMARY KEY,
  stars INTEGER NOT NULL
);
-- Akademin: the public page (intro, private lessons) and the groups shown there; interest from anyone (to the coaches)
CREATE TABLE IF NOT EXISTS academy (
  org TEXT PRIMARY KEY,
  intro TEXT,
  ptext TEXT,                                   -- private lessons: what is offered
  pprice TEXT,                                  -- private lessons: price, as the coach writes it
  updated INTEGER,
  by TEXT
);
CREATE TABLE IF NOT EXISTS tgroup_pub (
  gid TEXT PRIMARY KEY,
  shown INTEGER NOT NULL DEFAULT 0,
  level TEXT,
  sched TEXT,                                   -- e.g. "Onsdagar 19:00-20:30"
  max INTEGER,
  price TEXT,
  info TEXT
);
CREATE TABLE IF NOT EXISTS interest (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  kind TEXT NOT NULL,                           -- grupp, privat
  gid TEXT,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  age TEXT,
  msg TEXT,
  ip TEXT,
  created INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ny'             -- ny, kontaktad
);
CREATE INDEX IF NOT EXISTS interest_org ON interest(org, created);
