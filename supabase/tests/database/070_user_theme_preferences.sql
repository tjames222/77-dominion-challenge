begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(14);

select has_table('public', 'user_theme_preferences', 'theme preferences are stored separately from public profile data');
select is(
  has_table_privilege('authenticated', 'public.user_theme_preferences', 'SELECT'),
  false,
  'authenticated clients cannot read another preference through the table API'
);
select is(
  has_function_privilege('authenticated', 'public.get_theme_preference()', 'EXECUTE'),
  true,
  'authenticated clients can read their preference through the scoped RPC'
);
select is(
  has_function_privilege('authenticated', 'public.set_theme_preference(text)', 'EXECUTE'),
  true,
  'authenticated clients can set their preference through the validated RPC'
);
select is(
  has_function_privilege('anon', 'public.set_theme_preference(text)', 'EXECUTE'),
  false,
  'anonymous clients cannot set a theme preference'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '20000000-0000-4000-8000-000000000002';
set local "request.jwt.claims" = '{"sub":"20000000-0000-4000-8000-000000000002","role":"authenticated"}';

select is(
  public.get_theme_preference() ->> 'themeKey',
  null,
  'a user without a saved preference receives an explicit empty state'
);
select is(
  public.set_theme_preference('light') ->> 'themeKey',
  'light',
  'a public theme can be saved without a reward'
);
select is(
  public.get_theme_preference() ->> 'themeKey',
  'light',
  'the saved public preference is restored for the same account'
);
select throws_ok(
  $$ select public.set_theme_preference('dominion-night') $$,
  '42501',
  'Dominion Night has not been unlocked.',
  'the alternate theme cannot be saved without permanent ownership'
);
select throws_ok(
  $$ select public.set_theme_preference('unknown-theme') $$,
  '22023',
  'The requested theme is unavailable.',
  'unknown theme keys fail closed'
);

set local "request.jwt.claim.sub" = '10000000-0000-4000-8000-000000000001';
set local "request.jwt.claims" = '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  public.get_theme_preference() ->> 'themeKey',
  null,
  'one account cannot see another account preference'
);
select is(
  public.set_theme_preference('dominion-night') ->> 'themeKey',
  'dominion-night',
  'an owned Dominion Night entitlement authorizes the server preference'
);
select is(
  public.set_theme_preference('dark') ->> 'themeKey',
  'dark',
  'an owner can switch back to a public theme'
);
select is(
  (select count(*)::integer from public.user_theme_preferences),
  2,
  'each account has exactly one isolated preference row'
);

reset role;
select * from finish();
rollback;
