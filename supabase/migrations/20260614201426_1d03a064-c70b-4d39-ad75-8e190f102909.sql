
CREATE OR REPLACE FUNCTION public.verify_admin_password(p_password text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  stored text;
BEGIN
  SELECT password INTO stored FROM public.admin_config WHERE id = 1;
  IF stored IS NULL THEN RETURN false; END IF;
  RETURN stored = extensions.crypt(p_password, stored);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_admin_password(p_password text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF p_password IS NULL OR length(p_password) < 4 THEN
    RAISE EXCEPTION 'Password too short';
  END IF;
  UPDATE public.admin_config
  SET password = extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
      updated_at = now()
  WHERE id = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_admin_password(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_admin_password(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_admin_password(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_admin_password(text) TO service_role;
