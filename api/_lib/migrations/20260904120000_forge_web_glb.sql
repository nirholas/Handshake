-- Web-delivery variant of a finished forge mesh.
--
-- A raw generation ships 1-3.5 MB of PNG skins and unquantized vertex data.
-- On a mid-tier phone over slow 4G that is 15+ seconds before the first frame,
-- which is most of what made /marketplace and the model pages unusable on a
-- handset. The delivery pass (api/_lib/glb-compress.js, meshopt geometry plus
-- WebP textures capped at 2048 px) cuts real production meshes by 80-94%.
--
-- It is stored as a SECOND object rather than replacing the mesh: glb_url stays
-- exactly the bytes the caller's output_format asked for, so the download action
-- and every third-party API consumer keep the full-resolution original and no
-- bare GLTFLoader is handed an EXT_meshopt_compression file it cannot decode.
-- Our own viewers prefer web_glb_url and fall back to glb_url when the browser
-- cannot decode the compressed form.
--
-- Null on every existing row and on any row whose compression pass has not run
-- or did not shrink the mesh; readers must treat null as "serve glb_url".
alter table forge_creations
	add column if not exists web_glb_key   text,
	add column if not exists web_glb_url   text,
	add column if not exists web_size_bytes integer;

-- The backfill sweep asks for finished rows that have no web variant yet, newest
-- first. Partial so the index only covers the shrinking set of work to do.
create index if not exists forge_creations_web_glb_pending_idx
	on forge_creations (updated_at desc)
	where status = 'done' and glb_url is not null and web_glb_key is null;
