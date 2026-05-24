-- Migration: extend widgets.type CHECK constraint with the three new runtime
-- widget types (pumpfun-feed, kol-trades, live-trades-canvas) that already
-- ship with mount handlers in src/widgets/ and are exposed in the public
-- widgets gallery via demo fixtures.
-- Apply: npm run db:migrate -- --apply --file 2026-05-24-widget-types-expand.sql
-- Idempotent.

begin;

alter table widgets
    drop constraint if exists widgets_type_check;

alter table widgets
    add constraint widgets_type_check
    check (type in (
        'turntable',
        'animation-gallery',
        'talking-agent',
        'passport',
        'hotspot-tour',
        'pumpfun-feed',
        'kol-trades',
        'live-trades-canvas'
    ));

commit;
