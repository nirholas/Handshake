-- Feature "ansem-with-animation" and "Boss Vernington" community avatars.
-- The hero carousel (src/marketplace.js loadFeatured) reads avatars ordered
-- by featured DESC, created_at DESC and renders the GLB via <model-viewer>,
-- so no thumbnail upload is required for them to surface.

UPDATE avatars
SET featured = true
WHERE deleted_at IS NULL
  AND visibility = 'public'
  AND (
       name ILIKE 'ansem-with-animation'
    OR name ILIKE 'Boss Vernington'
  );
