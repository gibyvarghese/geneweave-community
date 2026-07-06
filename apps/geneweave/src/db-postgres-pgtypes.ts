// SPDX-License-Identifier: MIT
/**
 * Side-effect module: teach the `pg` driver to return BIGINT (int8, OID 20) as a JS number instead of
 * a string. The Postgres schema maps SQLite's 64-bit INTEGER to BIGINT (so epoch-millis and large
 * counts don't overflow int4); this parser makes those columns read back as numbers — byte-for-byte
 * with SQLite, whose INTEGER columns are already numbers. Every value the app stores is well below
 * 2^53, so Number() is lossless.
 *
 * Importing this module (which every db-postgres domain module does, transitively) installs the parser
 * once, globally on the shared `pg` type registry — so both the adapter's pool and any test pool see it.
 */
import pg from 'pg';

// OID 20 = int8/BIGINT. Return null untouched; otherwise a JS number.
pg.types.setTypeParser(20, (value: string | null): number | null => (value === null ? null : Number(value)));

export {};
