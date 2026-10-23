// SupaRace example: N clients each try to spend 1 credit from a wallet that holds N/2.
// Correct code approves at most N/2 spends and the final balance matches. Schema: suparace/quickstart.sql.
//
// A race file default-exports a race, an array of races, or a function ({ client, env }) => race | race[].
// client() returns a new supabase-js client for SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (no import needed).
// Hooks: setup -> worker (untimed, per worker) -> actor (timed; value = success, null = refused, throw = error)
//        -> invariants (read the database; every check must be true).
export default ({ client }) => {
  const admin = client();
  const WALLET = 1;

  const base = {
    setup: async ({ items }) => {
      const { error } = await admin.from('suparace_wallets').upsert({ id: WALLET, balance: items });
      if (error) throw error;
      return { start: items };
    },
    worker: async () => {
      const sb = client();
      await sb.from('suparace_wallets').select('id').limit(1); // open the connection before timing
      return sb;
    },
    invariants: async (ctx, out) => {
      const { data, error } = await admin.from('suparace_wallets').select('balance').eq('id', WALLET).single();
      if (error) throw error;
      const approved = out.successes.length;
      return {
        no_overspend: approved <= ctx.start,              // never approve more than the wallet held
        balance_matches: data.balance === ctx.start - approved, // no lost updates
      };
    },
  };

  return [
    {
      ...base,
      name: 'spend:naive',
      // The bug: read the balance, decide in JavaScript, write the new value. Another client can read the
      // same balance in between, so spends get approved twice and updates get lost.
      actor: async (sb) => {
        const { data, error } = await sb.from('suparace_wallets').select('balance').eq('id', WALLET).single();
        if (error) throw error;
        if (data.balance < 1) return null;
        const { error: e2 } = await sb.from('suparace_wallets').update({ balance: data.balance - 1 }).eq('id', WALLET);
        if (e2) throw e2;
        return data.balance - 1;
      },
    },
    {
      ...base,
      name: 'spend:atomic',
      // The fix: one RPC, the check and the write happen in one UPDATE inside Postgres.
      actor: async (sb) => {
        const { data, error } = await sb.rpc('suparace_spend', { p_wallet: WALLET, p_amount: 1 });
        if (error) throw error;
        return data; // null = refused (balance too low)
      },
    },
  ];
};
