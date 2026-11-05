import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const src = join(import.meta.dir, '..', 'apps/server/src')
const sql = new RegExp(
  [
    String.raw`\bsqlx::(query\w*|raw_sql|Executor)\b`,
    String.raw`\buse sqlx::[^;]*(\b(query\w*|raw_sql|Executor|prelude)\b|\*)`,
    String.raw`\bsqlx as\b`,
    String.raw`\.(execute|fetch\w*)\(\s*(r#*)?"`,
  ].join('|'),
  'g'
)
const permItem = new RegExp(
  [
    String.raw`\b(enum|struct|fn|const|static|type|trait)\s+(Perm|ALL_PERMS|perm_bits|can_moderate|can_grant|ChannelAccess|perm_subjects|PermRow|perm_row|Restrict|fold_access|rule_narrows)\b`,
    String.raw`\bpub(\([^)]*\))?\s+use\s[^;]*\bperms\b`,
  ].join('|')
)
const testModule = /^(pub(\([a-z]+\))? )?mod \w+ \{$/

const rustFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (name === 'tests' || name === 'tests.rs') return []
    if (statSync(path).isDirectory()) return rustFiles(path)
    return name.endsWith('.rs') ? [path] : []
  })

const code = (text: string) => {
  const lines = text.split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '#[cfg(test)]' && testModule.test(lines[i + 1] ?? '')) {
      while (i < lines.length && !lines[i].startsWith('}')) i++
      continue
    }
    kept.push(lines[i])
  }
  return kept.join('\n')
}
const queries = (text: string) => code(text).match(sql)?.length ?? 0
const permBits = (text: string) => permItem.test(code(text))

describe('access gate', () => {
  test('ws/ runs SQL only for call logs', () => {
    const ws = join(src, 'ws')
    const counts = new Map(
      rustFiles(ws).map(path => [relative(ws, path), queries(readFileSync(path, 'utf8'))])
    )
    const withQueries = [...counts]
      .filter(([, n]) => n > 0)
      .map(([file]) => file)
      .sort()
    expect(withQueries).toEqual(['calls.rs'])
    expect(counts.get('calls.rs')).toBeLessThanOrEqual(4)
  })

  test('db/ holds no permission bits', () => {
    const files = rustFiles(join(src, 'db'))
    expect(files.length).toBeGreaterThan(0)
    const offenders = files.filter(path => permBits(readFileSync(path, 'utf8')))
    expect(offenders.map(path => relative(src, path))).toEqual([])
  })

  test('the scans see code around test modules and skip the modules', () => {
    const text = [
      '#[cfg(test)]',
      'pub(crate) use repost::current;',
      'fn a(db: &Db) { sqlx::query("SELECT 1"); }',
      '#[cfg(test)]',
      'mod tests;',
      '#[cfg(test)]',
      'pub(crate) mod util {',
      '    fn b(db: &Db) { sqlx::query("SELECT 2"); }',
      '}',
      'fn c(db: &Db) { sqlx::query("SELECT 3"); }',
      '#[cfg(test)]',
      'mod tests {',
      '    fn d(db: &Db) { sqlx::query("SELECT 4"); }',
      '} // tests',
      'fn e(db: &Db) {',
      '    sqlx::query("SELECT 5");',
      '}',
    ].join('\n')
    expect(queries(text)).toBe(3)
    expect(permBits(['#[cfg(test)]', 'const T: i64 = 1;', 'pub enum Perm {}'].join('\n'))).toBe(
      true
    )
  })

  test('every way to run SQL counts', () => {
    const ways = [
      'sqlx::query("SELECT 1")',
      'sqlx::query_as::<_, (i64,)>("SELECT 1")',
      'sqlx::query_scalar("SELECT 1")',
      'sqlx::query_with("SELECT 1", args)',
      'sqlx::raw_sql("SELECT 1")',
      'use sqlx::query;',
      'use sqlx::query as q;',
      'use sqlx::{Executor, Row};',
      'use sqlx::{\n    Row,\n    raw_sql,\n};',
      'use sqlx as s;',
      'sqlx::Executor::fetch_all(db, "SELECT 1")',
      'db.fetch_optional("SELECT 1")',
      'db.execute(\n    "DELETE FROM t",\n)',
      'db.fetch_all(r#"SELECT 1"#)',
      'use sqlx::prelude::*;',
      'use sqlx::*;',
    ]
    for (const way of ways) expect([way, queries(way)]).toEqual([way, 1])
    const fine = [
      'use sqlx::Row;',
      'use sqlx::{AnyConnection, Row};',
      'fn f() -> sqlx::Result<()>',
      'r: &sqlx::any::AnyRow',
      'q.execute(db)',
      'q.fetch_optional(&mut *tx)',
    ]
    for (const way of fine) expect([way, queries(way)]).toEqual([way, 0])
  })

  test('every permission item counts', () => {
    const items = [
      'pub enum Perm {',
      'pub const ALL_PERMS: i64 = 511;',
      'pub fn perm_bits(is_admin: bool, perms: i64, roles: i64) -> i64 {',
      'pub fn can_moderate(actor: i64, actor_site_admin: bool, target: i64) -> bool {',
      'pub fn can_grant(actor: i64, actor_site_admin: bool, perms: i64) -> bool {',
      'pub struct ChannelAccess {',
      'pub async fn perm_subjects(',
      'pub struct PermRow {',
      'pub fn perm_row(r: &AnyRow, at: usize) -> sqlx::Result<PermRow> {',
      'pub struct Restrict {',
      "pub fn fold_access<'a>(",
      'pub fn rule_narrows(rule: &PermRow, restrict: Restrict) -> bool {',
      'type Restrict = (bool, bool);',
      'pub use crate::api::access::perms::*;',
      'pub(crate) use crate::api::access::perms::{Perm, fold_access};',
      'pub use crate::api::access::perms;',
      'pub(crate) use crate::api::access::{perms::*, timed_out};',
    ]
    for (const item of items) expect([item, permBits(item)]).toEqual([item, true])
    const fine = [
      'pub const OLD_ALL_PERMS: i64 = 255;',
      'use crate::api::access::perms::ALL_PERMS;',
      'let perms = perm_bits(true, 0, 0);',
      'fn perm_bits_of(row: &AnyRow) -> i64 {',
    ]
    for (const item of fine) expect([item, permBits(item)]).toEqual([item, false])
  })
})
