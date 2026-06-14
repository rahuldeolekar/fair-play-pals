
-- Enable pgcrypto for bcrypt
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

-- Rehash existing plaintext password (one-time): if it doesn't look like a bcrypt hash, hash it.
UPDATE public.admin_config
SET password = crypt(password, gen_salt('bf', 10))
WHERE password IS NOT NULL AND password NOT LIKE '$2%';

-- Secure verify function (SECURITY DEFINER, fixed search_path)
CREATE OR REPLACE FUNCTION public.verify_admin_password(p_password text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  stored text;
BEGIN
  SELECT password INTO stored FROM public.admin_config WHERE id = 1;
  IF stored IS NULL THEN RETURN false; END IF;
  RETURN stored = crypt(p_password, stored);
END;
$$;

-- Secure update function
CREATE OR REPLACE FUNCTION public.set_admin_password(p_password text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_password IS NULL OR length(p_password) < 4 THEN
    RAISE EXCEPTION 'Password too short';
  END IF;
  UPDATE public.admin_config
  SET password = crypt(p_password, gen_salt('bf', 10)),
      updated_at = now()
  WHERE id = 1;
END;
$$;

-- Lock down RPC exposure: only service_role may call these.
REVOKE ALL ON FUNCTION public.verify_admin_password(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_admin_password(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_admin_password(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_admin_password(text) TO service_role;

-- Add an explicit deny policy on admin_config so RLS isn't "enabled with no policy".
-- service_role bypasses RLS, so trusted server code still works.
DROP POLICY IF EXISTS "Deny all client access to admin_config" ON public.admin_config;
CREATE POLICY "Deny all client access to admin_config"
ON public.admin_config
AS RESTRICTIVE
FOR ALL
TO anon, authenticated
USING (false)
WITH CHECK (false);
