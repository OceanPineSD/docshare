import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Add a Postgres database in Replit.");
}

export const pool = new pg.Pool({
  connectionString,
  ssl: /localhost|127\.0\.0\.1/.test(connectionString)
    ? false
    : { rejectUnauthorized: false },
  max: 5,
});

export const q = (text, params) => pool.query(text, params);

const schema = `
create table if not exists documents (
  id text primary key,
  title text not null,
  filename text not null,
  size_bytes integer not null,
  page_count integer,
  created_at timestamptz not null default now()
);

create table if not exists document_files (
  document_id text primary key references documents(id) on delete cascade,
  data bytea not null
);

create table if not exists links (
  id text primary key,
  document_id text not null references documents(id) on delete cascade,
  label text not null,
  require_email boolean not null default true,
  allow_download boolean not null default false,
  expires_at timestamptz,
  disabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists views (
  id text primary key,
  link_id text not null references links(id) on delete cascade,
  email text,
  user_agent text,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists page_views (
  view_id text not null references views(id) on delete cascade,
  page integer not null,
  duration_ms integer not null default 0,
  primary key (view_id, page)
);

create index if not exists links_document_idx on links(document_id);
create index if not exists views_link_idx on views(link_id);
`;

export async function migrate() {
  await pool.query(schema);
}
