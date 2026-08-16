CREATE TABLE public.chartability_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label text NOT NULL,
  generated_at timestamptz,
  motif_class text,
  dims text,
  colour_count integer,
  prompt text,
  verdict text NOT NULL CHECK (verdict IN ('Perfect','Minor','Poor','Unusable')),
  signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  rated_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.chartability_ratings TO authenticated;
GRANT ALL ON public.chartability_ratings TO service_role;

ALTER TABLE public.chartability_ratings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own ratings"
  ON public.chartability_ratings FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own ratings"
  ON public.chartability_ratings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own ratings"
  ON public.chartability_ratings FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own ratings"
  ON public.chartability_ratings FOR DELETE
  USING (auth.uid() = user_id);

CREATE INDEX chartability_ratings_user_id_idx ON public.chartability_ratings(user_id);

CREATE TRIGGER chartability_ratings_set_updated_at
  BEFORE UPDATE ON public.chartability_ratings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
