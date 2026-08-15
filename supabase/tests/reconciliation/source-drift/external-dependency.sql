create schema reconciliation_external;

create table reconciliation_external.purchase_audit (
  purchase_id uuid primary key references public.purchases(id) on delete restrict
);

create view reconciliation_external.purchase_ids as
select purchase.id
from public.purchases purchase;
