CREATE FUNCTION kaneo_managed_marker_key(description text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE marker text; identity_key text;
BEGIN
  IF (SELECT count(*) FROM regexp_matches(description, '<!-- kaneo-managed:', 'g')) <> 1 THEN
    RETURN NULL;
  END IF;
  marker := substring(description FROM '<!-- kaneo-managed:([^\n]*?) -->');
  identity_key := (marker::jsonb)->>'key';
  IF length(identity_key) BETWEEN 1 AND 512 AND identity_key ~ '^[a-zA-Z0-9:._/-]+$' THEN RETURN identity_key; END IF;
  RETURN NULL;
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION kaneo_sync_managed_marker() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE marker_key text;
BEGIN
  marker_key := kaneo_managed_marker_key(NEW.description);
  IF marker_key IS NOT NULL THEN
    IF NEW.managed_key IS NULL THEN
      NEW.managed_key := marker_key;
    ELSIF NEW.managed_key <> marker_key THEN
      RAISE EXCEPTION 'Managed marker disagrees with task identity'
        USING ERRCODE = '23514', CONSTRAINT = 'task_managed_marker_matches_key';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER task_managed_marker_identity BEFORE INSERT OR UPDATE OF description, managed_key
ON task FOR EACH ROW EXECUTE FUNCTION kaneo_sync_managed_marker();
