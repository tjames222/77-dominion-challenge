alter table public.profiles
  add constraint reconciliation_changed_profile_name
  check (char_length(name) < 500);
