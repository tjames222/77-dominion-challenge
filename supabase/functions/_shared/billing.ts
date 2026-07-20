import { createFormBody, stripeRequest } from "./stripe.ts";

type SupabaseAdmin = {
  // Supabase query builders are promise-like and heavily generic; this shared
  // helper only needs the small subset used below.
  from: (table: string) => any;
};

type SupabaseUser = {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown>;
};

type QueryBuilder<T> = {
  eq: (column: string, value: string) => QueryBuilder<T>;
  maybeSingle: () => Promise<{ data: T | null; error?: Error | null }>;
};

type BillingCustomer = {
  stripe_customer_id: string;
};

type Profile = {
  name?: string | null;
  email?: string | null;
};

function asQueryBuilder<T>(value: unknown) {
  return value as QueryBuilder<T>;
}

export async function getOrCreateStripeCustomer(
  admin: SupabaseAdmin,
  user: SupabaseUser,
  requestStripe: typeof stripeRequest = stripeRequest,
) {
  const [customerResult, profileResult] = await Promise.all([
    asQueryBuilder<BillingCustomer>(
      admin
        .from("billing_customers")
        .select("stripe_customer_id"),
    )
      .eq("user_id", user.id)
      .maybeSingle(),
    asQueryBuilder<Profile>(
      admin
        .from("profiles")
        .select("name, email"),
    )
      .eq("user_id", user.id)
      .maybeSingle(),
  ]);

  if (customerResult.error) throw customerResult.error;
  if (profileResult.error) throw profileResult.error;
  if (customerResult.data?.stripe_customer_id) {
    return customerResult.data.stripe_customer_id;
  }

  const email = user.email || profileResult.data?.email || "";
  const metadataName = typeof user.user_metadata?.name === "string"
    ? user.user_metadata.name
    : "";
  const name = profileResult.data?.name || metadataName;
  const customer = await requestStripe(
    "/v1/customers",
    "POST",
    createFormBody({
      email,
      name,
      "metadata[user_id]": user.id,
    }),
  ) as { id: string };

  const { error } = await admin.from("billing_customers").upsert({
    user_id: user.id,
    stripe_customer_id: customer.id,
    email,
  }, { onConflict: "user_id" });
  if (error) throw error;

  return customer.id;
}
