-- Run after the server created the schema and the accounts admin and pwref exist.
\set ON_ERROR_STOP on
\timing on
SET synchronous_commit = off;

INSERT INTO users(username, display_name, password_hash, password_kind, avatar_kind, created_at)
SELECT 'u' || lpad(i::text, 5, '0'), 'User ' || i, (SELECT password_hash FROM users WHERE username = 'pwref'), 'text', 'identicon', 1700000000 + i
FROM generate_series(0, 4999) i;
INSERT INTO tokens(token, username, created_at)
SELECT 'h:' || encode(sha256(convert_to('tok-u' || lpad(i::text, 5, '0'), 'UTF8')), 'hex'), 'u' || lpad(i::text, 5, '0'), 1700000000
FROM generate_series(0, 4999) i;

INSERT INTO servers(name, display_name, creator, created_at) VALUES ('big', 'Big Org', 'u00000', 1700000000);
INSERT INTO servers(name, display_name, creator, created_at)
SELECT 's' || lpad(i::text, 3, '0'), 'Server ' || i, 'u00000', 1700000000 + i FROM generate_series(1, 199) i;

INSERT INTO channels(server, name, created_at, position)
SELECT 'big', 'chan-' || lpad(i::text, 3, '0'), 1700000000, i FROM generate_series(0, 99) i;
INSERT INTO channels(server, name, created_at, position)
SELECT 's' || lpad(s::text, 3, '0'), 'chan-' || c, 1700000000, c FROM generate_series(1, 199) s, generate_series(0, 4) c;

INSERT INTO members(server, username, is_admin, joined_at)
SELECT 'big', 'u' || lpad(i::text, 5, '0'), CASE WHEN i = 0 THEN 1 ELSE 0 END, 1600000000 FROM generate_series(0, 4999) i;
INSERT INTO members(server, username, is_admin, joined_at)
SELECT 's' || lpad(s::text, 3, '0'), 'u' || lpad(i::text, 5, '0'), CASE WHEN i = 0 THEN 1 ELSE 0 END, 1600000000
FROM generate_series(1, 199) s, generate_series(0, 99) i;
INSERT INTO members(server, username, is_admin, joined_at)
SELECT 's' || lpad(s::text, 3, '0'), 'u' || lpad(i::text, 5, '0'), 0, 1600000000
FROM generate_series(1, 199) s, generate_series(1000, 1999) i;
INSERT INTO members(server, username, is_admin, joined_at)
SELECT DISTINCT 's' || lpad(s::text, 3, '0'), 'u' || lpad((100 + ((s * 50 + k) * 37) % 4900)::text, 5, '0'), 0, 1600000000
FROM generate_series(1, 199) s, generate_series(0, 49) k
ON CONFLICT DO NOTHING;
UPDATE servers SET member_count = (SELECT COUNT(*) FROM members WHERE members.server = servers.name);

CREATE TEMP TABLE words(w text[]);
INSERT INTO words VALUES (ARRAY['alpha','budget','quarterly','deploy','kubernetes','meeting','review','invoice','roadmap','incident','customer','release','design','hiring','migration','database','latency','pager','oncall','retro','sprint','launch','metrics','dashboard','contract','legal','security','audit','vendor','travel','lunch','offsite','report','pipeline','storage','network','firewall','rollback','hotfix','feature']);
INSERT INTO messages(channel_id, author, content, created_at)
SELECT c.id,
       'u' || lpad(((g * 7919) % 5000)::text, 5, '0'),
       (SELECT string_agg(w[1 + ((g * 31 + k * 17) % 40)], ' ') FROM words, generate_series(1, 8) k) || ' #' || g,
       1700000000 + g
FROM generate_series(0::bigint, 599999::bigint) g
JOIN (SELECT id, row_number() OVER (ORDER BY id) - 1 AS n FROM channels WHERE server = 'big') c ON c.n = g % 100;
INSERT INTO messages(channel_id, author, content, created_at)
SELECT c.id,
       'u' || lpad(((g * 7919) % 150)::text, 5, '0'),
       (SELECT string_agg(w[1 + ((g * 13 + k * 29) % 40)], ' ') FROM words, generate_series(1, 8) k) || ' #s' || g,
       1700600000 + g
FROM generate_series(0::bigint, 399999::bigint) g
JOIN (SELECT id, row_number() OVER (ORDER BY id) - 1 AS n FROM channels WHERE server <> 'big') c ON c.n = g % 995;

INSERT INTO read_state(username, scope, last_read)
SELECT m.username, 'c' || c.id, x.mid
FROM members m JOIN channels c ON c.server = m.server
JOIN LATERAL (SELECT MIN(id) + (MAX(id) - MIN(id)) / 2 AS mid FROM messages WHERE channel_id = c.id) x ON x.mid IS NOT NULL
WHERE m.username IN (SELECT 'u' || lpad(i::text, 5, '0') FROM generate_series(0, 99) i)
ON CONFLICT DO NOTHING;

VACUUM ANALYZE;
SELECT (SELECT count(*) FROM users) users, (SELECT count(*) FROM servers) servers, (SELECT count(*) FROM members) members, (SELECT count(*) FROM channels) channels, (SELECT count(*) FROM messages) messages, (SELECT count(*) FROM read_state) reads, (SELECT count(*) FROM servers WHERE member_count <> (SELECT count(*) FROM members WHERE members.server = servers.name)) wrong_counts;
