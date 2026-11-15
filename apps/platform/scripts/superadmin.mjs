// Grants (or revokes) platform super admin via the exclusive platform_superadmins table.
//   node scripts/superadmin.mjs <email> [tenant-slug] [--revoke]
// Prefer the Super admins UI when someone is already a super admin.
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
  const users = await sql`
    select u.id, u.email, t.slug
    from users u
    join tenants t on t.id = u.tenant_id
    where u.email = ${email.toLowerCase()}
      and (${slug ?? null}::text is null or t.slug = ${slug ?? null})`;
  if (users.length === 0) {
    console.error('no matching user');
    process.exitCode = 1;
  } else if (users.length > 1 && !slug) {
    console.error('e-mail exists in several organizations: pass the tenant slug');
    process.exitCode = 1;
  } else {
    const u = users[0];
    if (revoke) {
      const [{ n }] = await sql`select count(*)::int as n from platform_superadmins`;
      if (n <= 1) {
        console.error('cannot revoke the last platform super admin');
        process.exitCode = 1;
      } else {
        await sql`delete from platform_superadmins where user_id = ${u.id}`;
        console.error(`revoked super admin: ${u.email} (${u.slug})`);
      }
    } else {
      await sql`
        insert into platform_superadmins (user_id, granted_by)
        values (${u.id}, null)
        on conflict (user_id) do nothing`;
      console.error(`granted super admin: ${u.email} (${u.slug})`);
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}
