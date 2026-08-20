-- Grokbots and Rakazo use different meanings for "description". Keep Rakazo's
-- short blurb distinct from its persona, even for direct database writers.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'bots_description_instructions_distinct'
      AND conrelid = 'bots'::regclass
  ) THEN
    ALTER TABLE "bots"
      ADD CONSTRAINT "bots_description_instructions_distinct"
      CHECK (
        "description" = ''
        OR "instructions" = ''
        OR "description" <> "instructions"
      ) NOT VALID;
  END IF;
END
$$;
