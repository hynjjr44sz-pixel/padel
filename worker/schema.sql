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
