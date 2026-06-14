import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { AppState } from "./shuttle-logic";

// ─────────────────────────────────────────────────────────────────────────────
// Admin session tokens (HMAC-signed, short-lived).
// The client only ever holds an opaque token — never the password itself.
// ─────────────────────────────────────────────────────────────────────────────
const TOKEN_TTL_MS = 1000 * 60 * 60 * 12; // 12h

async function hmac(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function getSigningSecret(): string {
  const s = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) throw new Error("Server misconfigured: missing signing secret");
  return s;
}

async function mintToken(): Promise<string> {
  const payload = { exp: Date.now() + TOKEN_TTL_MS };
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const sig = await hmac(getSigningSecret(), body);
  return `${body}.${sig}`;
}

async function verifyToken(token: string): Promise<boolean> {
  if (!token || typeof token !== "string") return false;
  const [body, sig] = token.split(".");
  if (!body || !sig) return false;
  const expected = await hmac(getSigningSecret(), body);
  if (expected !== sig) return false;
  try {
    const padded = body + "=".repeat((4 - (body.length % 4)) % 4);
    const json = JSON.parse(atob(padded.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json.exp === "number" && json.exp > Date.now();
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public read: anyone can fetch app state (no password inside).
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Verify admin password → issue session token.
// ─────────────────────────────────────────────────────────────────────────────
export const verifyAdminPassword = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ password: z.string().min(1).max(200) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: ok, error } = await supabaseAdmin.rpc("verify_admin_password", {
      p_password: data.password,
    });
    if (error) throw new Error("Server error");
    if (!ok) throw new Error("Incorrect admin password.");
    return { token: await mintToken() };
  });

// ─────────────────────────────────────────────────────────────────────────────
// Protected write: caller must present a valid token.
// ─────────────────────────────────────────────────────────────────────────────
const writeSchema = z.object({
  token: z.string().min(1).max(2000),
  patch: z.record(z.unknown()),
});

export const updateAppState = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => writeSchema.parse(input))
  .handler(async ({ data }) => {
    if (!(await verifyToken(data.token))) {
      throw new Error("Session expired. Please sign in again.");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const current = await supabaseAdmin
      .from("app_state")
      .select("data, version")
      .eq("id", 1)
      .single();
    if (current.error) throw new Error(current.error.message);

    const currentState = current.data.data as AppState;
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

// ─────────────────────────────────────────────────────────────────────────────
// Update admin password + email notification to security contact.
// ─────────────────────────────────────────────────────────────────────────────
const NOTIFY_EMAIL = "rahuldeolekar4@gmail.com";

async function sendPasswordChangedEmail(newPassword: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[admin] RESEND_API_KEY not set — skipping email notification.");
    return;
  }
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: "ShuttleScore <onboarding@resend.dev>",
        to: [NOTIFY_EMAIL],
        subject: "🔐 ShuttleScore admin password was changed",
        html: `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">
            <h2 style="margin:0 0 12px">Admin password updated</h2>
            <p>The ShuttleScore admin password was just changed.</p>
            <p style="background:#f3f4f6;padding:12px 16px;border-radius:6px;font-family:monospace;font-size:15px">
              <strong>New password:</strong> ${newPassword.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!))}
            </p>
            <p style="color:#6b7280;font-size:13px">Time: ${new Date().toISOString()}</p>
            <p style="color:#6b7280;font-size:13px">If you didn't authorise this change, rotate the password immediately.</p>
          </div>
        `,
      }),
    });
    if (!resp.ok) {
      console.error("[admin] Resend email failed:", resp.status, await resp.text());
    }
  } catch (e) {
    console.error("[admin] Email send error:", e);
  }
}

export const updateAdminPassword = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({
      token: z.string().min(1).max(2000),
      newPassword: z.string().min(4).max(200),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    if (!(await verifyToken(data.token))) {
      throw new Error("Session expired. Please sign in again.");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.rpc("set_admin_password", {
      p_password: data.newPassword,
    });
    if (error) throw new Error(error.message);

    // Fire-and-forget email (don't fail the request if email fails).
    await sendPasswordChangedEmail(data.newPassword);

    return { ok: true, token: await mintToken() };
  });
