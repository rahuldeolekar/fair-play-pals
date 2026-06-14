import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { AppState } from "./shuttle-logic";

// Public read: anyone can fetch current state (RLS allows it too, but going
// through a server fn keeps the API surface tidy).
export const getAppState = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("app_state")
    .select("data, version, updated_at")
    .eq("id", 1)
    .single();
  if (error) throw new Error(error.message);
  return data as { data: AppState; version: number; updated_at: string };
});

// Protected write: caller must supply the admin password stored inside state.
// We verify against the CURRENT row each time, so password changes take effect
// immediately and we never trust the client's copy of `state.password`.
const writeSchema = z.object({
  password: z.string().min(1).max(200),
  patch: z.record(z.string(), z.unknown()), // partial AppState
});

export const updateAppState = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => writeSchema.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const current = await supabaseAdmin
      .from("app_state")
      .select("data, version")
      .eq("id", 1)
      .single();
    if (current.error) throw new Error(current.error.message);

    const currentState = current.data.data as AppState;
    if ((data.password ?? "") !== (currentState.password ?? "")) {
      throw new Error("Incorrect admin password.");
    }

    const next: AppState = { ...currentState, ...(data.patch as Partial<AppState>) };
    const { error } = await supabaseAdmin
      .from("app_state")
      .update({
        data: next,
        version: current.data.version + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);
    if (error) throw new Error(error.message);
    return { ok: true, version: current.data.version + 1 };
  });
