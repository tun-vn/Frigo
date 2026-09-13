-- Migration 0023: bind a scan command to its original image payload.
-- Nullable columns keep existing production scans/replays backward compatible;
-- new requests persist a fingerprint and MIME type before any AI work starts.
ALTER TABLE scans ADD COLUMN request_fingerprint TEXT;
ALTER TABLE scans ADD COLUMN image_mime_type TEXT;

CREATE INDEX IF NOT EXISTS idx_scans_request_fingerprint
  ON scans(user_id, household_id, request_fingerprint);
