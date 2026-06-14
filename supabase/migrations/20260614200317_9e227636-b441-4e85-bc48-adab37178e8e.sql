
-- 1. Private admin_config table (service_role only — no anon/authenticated grants)
CREATE TABLE public.admin_config (
  id INT PRIMARY KEY DEFAULT 1,
  password TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT admin_config_singleton CHECK (id = 1)
);

GRANT ALL ON public.admin_config TO service_role;
-- intentionally NO grants to anon or authenticated

ALTER TABLE public.admin_config ENABLE ROW LEVEL SECURITY;
-- No policies created → anon/authenticated have zero access; only service_role (which bypasses RLS) can touch it.

-- 2. Seed with current password
INSERT INTO public.admin_config (id, password) VALUES (1, 'badminton123');

-- 3. Strip password out of the public app_state row
UPDATE public.app_state
SET data = data - 'password'
WHERE id = 1;

-- 4. Realtime messages: restrict channel subscriptions to the public app_state topic only
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'realtime' AND tablename = 'messages'
  ) THEN
    EXECUTE 'ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "Allow app_state topic only" ON realtime.messages';
    EXECUTE $POL$
      CREATE POLICY "Allow app_state topic only"
      ON realtime.messages
      FOR SELECT
      TO anon, authenticated
      USING (topic = 'app_state_room' OR topic LIKE 'realtime:public:app_state%')
    $POL$;
  END IF;
END $$;
