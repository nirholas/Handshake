-- Deleting a creation must be able to erase the user's uploaded reference
-- photos, not just the generated mesh. Uploads land in the bucket under
-- forge/uploads/<client12>/<uuid>.<ext> (api/forge-upload.js), but until now no
-- row remembered which upload objects fed a generation: materializeCreation
-- overwrites preview_image_url with the durable copy, so the original photo's
-- key was unrecoverable and the object lived forever even after the creation
-- was discarded. That is unacceptable the moment a paying customer uploads a
-- personal photo for image-to-3D.
--
-- source_image_keys is a jsonb array of bucket keys (all reference views, not
-- just the primary one) recorded at createCreation time. deleteCreation
-- (api/_lib/forge-store.js) removes every listed object along with the stored
-- GLB and preview when the owner deletes the creation from their gallery.
alter table forge_creations
	add column if not exists source_image_keys jsonb;
