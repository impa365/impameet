// Grants (or revokes) platform super admin rights to an existing user.
//   node scripts/superadmin.mjs <email> [tenant-slug] [--revoke]
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const args = process.argv.slice(2);
const revoke = args.includes('--revoke');
const [email, slug] = args.filter((a) => a !== '--revoke');
if (!email) {
  console.error('usage: node scripts/superadmin.mjs <email> [tenant-slug] [--revoke]');
  process.exit(2);
}

const file = process.env.DATABASE_URL_FILE;
const url = file ? readFileSync(file, 'utf8').trim() : process.env.DATABASE_URL;
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const rows = await sql`
    update users u set is_superadmin = ${!revoke}
    from tenants t
    where t.id = u.tenant_id and u.email = ${email.toLowerCase()}
      and (${slug ?? null}::text is null or t.slug = ${slug ?? null})
    returning u.email, t.slug`;
  if (rows.length === 0) {
    console.error('no matching user');
    process.exitCode = 1;
  } else if (rows.length > 1 && !slug) {
    console.error('e-mail exists in several organizations: pass the tenant slug');
    process.exitCode = 1;
  } else {
    for (const r of rows)
      console.error(`${revoke ? 'revoked' : 'granted'} super admin: ${r.email} (${r.slug})`);
  }
} finally {
  await sql.end({ timeout: 5 });
}
