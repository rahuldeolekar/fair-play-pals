
CREATE TABLE public.app_state (
  id INT PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_state_singleton CHECK (id = 1)
);

GRANT SELECT ON public.app_state TO anon, authenticated;
GRANT ALL ON public.app_state TO service_role;

ALTER TABLE public.app_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read app state"
  ON public.app_state FOR SELECT
  TO anon, authenticated
  USING (true);

-- No INSERT/UPDATE/DELETE policies: only service_role (server functions) can write.

ALTER PUBLICATION supabase_realtime ADD TABLE public.app_state;
ALTER TABLE public.app_state REPLICA IDENTITY FULL;

INSERT INTO public.app_state (id, data) VALUES (1, '{
  "players": [
    {"id":1,"name":"Shreyas","tier":1,"freq":"Frequent","rating":1200,"gamesPlayed":0,"totalFor":0,"totalAgainst":0,"present":false,"gamesToday":0},
    {"id":2,"name":"Anup","tier":1,"freq":"Frequent","rating":1180,"gamesPlayed":0,"totalFor":0,"totalAgainst":0,"present":false,"gamesToday":0},
    {"id":3,"name":"Prashant","tier":1,"freq":"Frequent","rating":1150,"gamesPlayed":0,"totalFor":0,"totalAgainst":0,"present":false,"gamesToday":0},
    {"id":4,"name":"Bhavani","tier":1,"freq":"Rare","rating":1100,"gamesPlayed":0,"totalFor":0,"totalAgainst":0,"present":false,"gamesToday":0},
    {"id":5,"name":"Prassana","tier":1,"freq":"Rare","rating":1100,"gamesPlayed":0,"totalFor":0,"totalAgainst":0,"present":false,"gamesToday":0},
    {"id":6,"name":"Kaustubh","tier":0,"freq":"New","rating":750,"gamesPlayed":0,"totalFor":0,"totalAgainst":0,"present":false,"gamesToday":0},
    {"id":7,"name":"Rahul","tier":2,"freq":"Frequent","rating":950,"gamesPlayed":0,"totalFor":0,"totalAgainst":0,"present":false,"gamesToday":0},
    {"id":8,"name":"Vinit","tier":2,"freq":"Frequent","rating":940,"gamesPlayed":0,"totalFor":0,"totalAgainst":0,"present":false,"gamesToday":0},
    {"id":9,"name":"Sreelal","tier":2,"freq":"Frequent","rating":930,"gamesPlayed":0,"totalFor":0,"totalAgainst":0,"present":false,"gamesToday":0},
    {"id":10,"name":"Madhav","tier":2,"freq":"Frequent","rating":920,"gamesPlayed":0,"totalFor":0,"totalAgainst":0,"present":false,"gamesToday":0},
    {"id":11,"name":"Vignesh","tier":2,"freq":"Semi","rating":880,"gamesPlayed":0,"totalFor":0,"totalAgainst":0,"present":false,"gamesToday":0},
    {"id":12,"name":"Jojo","tier":2,"freq":"Semi","rating":850,"gamesPlayed":0,"totalFor":0,"totalAgainst":0,"present":false,"gamesToday":0},
    {"id":13,"name":"Apurva","tier":2,"freq":"Frequent","rating":830,"gamesPlayed":0,"totalFor":0,"totalAgainst":0,"present":false,"gamesToday":0},
    {"id":14,"name":"Vishnu","tier":2,"freq":"Semi","rating":800,"gamesPlayed":0,"totalFor":0,"totalAgainst":0,"present":false,"gamesToday":0},
    {"id":15,"name":"Sreekumar","tier":2,"freq":"Semi","rating":800,"gamesPlayed":0,"totalFor":0,"totalAgainst":0,"present":false,"gamesToday":0},
    {"id":16,"name":"Ife","tier":0,"freq":"New","rating":750,"gamesPlayed":0,"totalFor":0,"totalAgainst":0,"present":false,"gamesToday":0},
    {"id":17,"name":"AG","tier":0,"freq":"New","rating":750,"gamesPlayed":0,"totalFor":0,"totalAgainst":0,"present":false,"gamesToday":0},
    {"id":18,"name":"Guest Player","tier":0,"freq":"New","rating":750,"gamesPlayed":0,"totalFor":0,"totalAgainst":0,"present":false,"gamesToday":0}
  ],
  "matches": [],
  "currentMatches": [],
  "customLocked": null,
  "mode": "normal",
  "password": "badminton123",
  "nextId": 19,
  "courts": 2,
  "matchTarget": 21,
  "dayKey": ""
}'::jsonb);
