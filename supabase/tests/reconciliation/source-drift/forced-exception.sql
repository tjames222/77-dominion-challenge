do $forced_failure$
begin
  raise exception 'forced baseline reconciliation failure';
end;
$forced_failure$;
