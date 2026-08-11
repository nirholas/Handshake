#!/usr/bin/env bash
#
# revert-to-free.sh — flip every credit-funded GCP reroute back to its
# pre-program provider by REMOVING env vars. Never migrates code.
#
# The GCP $THREE credit program routed three real, shipped lanes onto Google
# infrastructure, each behind an env-var gate with an automatic fall-through to
# the provider it displaced:
#
#   Lane                     GCP env gate (present ⇒ lane live)     Falls back to
#   ─────────────────────────────────────────────────────────────────────────────
#   Forge image→3D (native)  MODEL_TRELLIS_URL   + GCP_RECON_KEY    free NIM/HF, then Replicate
#   Forge image→3D (hi-poly) GCP_HUNYUAN3D_URL   + GCP_RECON_KEY    free HF Spaces, then Replicate
#   Forge sketch→3D          GCP_TRIPOSG_URL     + GCP_RECON_KEY    (no fallback — lane simply off)
#   Game-Ready remesh export GCP_REMESH_URL      + GCP_RECON_KEY    (export hidden until reconfigured)
#   Avatar reconstruct/rerig GCP_RECONSTRUCTION_URL + _KEY          Replicate, then HF Spaces
#   Editing (rembg/tex/seg)  GCP_REMBG/TEXTURE/SEGMENT_URL          in-lane fallbacks / feature off
#   Imagen text→image        GOOGLE_CLOUD_PROJECT (+SA JSON)        free NIM FLUX, then Replicate
#   Vertex Claude (chat/LLM) VERTEX_CLAUDE_ENABLED / _PRIMARY       Groq→OpenRouter→NVIDIA→paid
#
# Because every lane is env-gated (see api/_lib/forge-tiers.js backendIsConfigured,
# api/_lib/regen-provider.js resolveProviderName, api/_mcp3d/vertex-imagen.js
# isConfigured, api/_lib/vertex-claude.js vertexClaudeEnabled), removing the gate
# var is a complete, code-free revert: the resolver stops selecting the GCP lane
# and the next configured provider serves the request. Proven at the code level by
# tests/api/gcp-revert.test.js.
#
# Sibling: scripts/gcp/emergency-stop.sh is the PANIC button (runaway cost, right
# now) — it also drops Cloud Run to min-instances=0 and prints the env removals.
# THIS script is the planned end-of-program revert: same env-flip mechanism, plus
# the pre-flight fallback checks and the full keep/kill context in docs/gcp-credits.md.
#
# This script does NOT touch prod env for you (it can't safely read your token/
# creds from here). It prints the exact `gcloud run services update
# three-ws-api --remove-env-vars/--remove-secrets` commands to paste — production
# is Cloud Run (docs/ops/gcp-production.md, migrated 2026-07-07), NOT Vercel; the
# GCP-credits env vars live on that one Cloud Run service now (see the 2026-07-08
# audit section in docs/gcp-credits.md) — plus the legacy `vercel env rm`
# commands for completeness, since some of the Vercel project's env may still be
# read by anything not yet decommissioned there. And — with --apply and gcloud
# authed — drops every Cloud Run worker to min-instances=0 so no warm GPU bills
# after the credits die.
#
# The Vertex Claude chat lane (api/_lib/vertex-claude.js, wired into api/chat.js)
# reverts by unsetting VERTEX_CLAUDE_ENABLED / VERTEX_CLAUDE_PRIMARY: the chat
# provider ladder then drops Vertex and leads with the free lanes again. Leaving
# GOOGLE_CLOUD_PROJECT set is harmless once the flags are off — the flag, not the
# project var, is what injects Vertex into the chat chain.
#
# Usage:
#   scripts/gcp/revert-to-free.sh                 # dry-run: print the plan, change nothing
#   scripts/gcp/revert-to-free.sh --apply         # run the Cloud Run min-instances=0 updates
#   scripts/gcp/revert-to-free.sh --apply --yes   # …without the confirm prompt
#
# Idempotent: running it twice is a no-op the second time (min-instances already
# 0, env vars already the ones you're told to remove). Safe to re-run.
#
# Env (only used with --apply, for the Cloud Run half):
#   PROJECT_ID   GCP project the workers live in   (default: gcloud's active project)
#   REGION       Cloud Run region                  (default: us-central1)
#   SERVICES     space-separated Cloud Run service names to zero out
#                (default: the full known worker set)

set -euo pipefail

# ── args ──────────────────────────────────────────────────────────────────────
APPLY=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --apply)     APPLY=1 ;;
    --dry-run)   APPLY=0 ;;
    --yes|-y)    ASSUME_YES=1 ;;
    -h|--help)   sed -n '2,55p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
  esac
done

REGION="${REGION:-us-central1}"
SERVICES="${SERVICES:-model-trellis model-hunyuan3d model-triposr model-triposg model-rig avatar-pipeline-controller rembg remesh texture segment}"

# ── styling ───────────────────────────────────────────────────────────────────
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*"; }
ok()    { printf '\033[32m%s\033[0m\n' "$*"; }

if [ "$APPLY" -eq 1 ]; then
  bold "▶ revert-to-free — APPLY mode (Cloud Run min-instances → 0)"
else
  bold "▶ revert-to-free — DRY RUN (nothing will change; re-run with --apply to execute)"
fi
echo

# ── the env vars that gate each GCP lane, grouped by what removing them reverts ─
# Keep this list in sync with .env.example and the *_URL gates read in api/.
FORGE_VARS=(MODEL_TRELLIS_URL GCP_HUNYUAN3D_URL GCP_TRIPOSG_URL GCP_REMESH_URL GCP_RECONSTRUCTION_URL GCP_RECONSTRUCTION_KEY)
EDIT_VARS=(GCP_REMBG_URL GCP_TEXTURE_URL GCP_SEGMENT_URL)
IMAGEN_VARS=(GOOGLE_CLOUD_PROJECT GOOGLE_CLOUD_LOCATION VERTEX_IMAGEN_MODEL VERTEX_IMAGEN_EDIT_MODEL GCP_SERVICE_ACCOUNT_JSON)
# The chat/LLM lane reverts by flag alone — turning these off drops Vertex from the
# chat provider ladder (api/chat.js providerOrder) without touching GOOGLE_CLOUD_PROJECT.
LLM_VARS=(VERTEX_CLAUDE_PRIMARY VERTEX_CLAUDE_ENABLED)

# ── Step 1: pre-flight — will anything be stranded with no fallback? ───────────
bold "1) Pre-flight: confirm each lane has a live fallback before you pull the gate"
echo
# Avatar reconstruct/rerig falls back to Replicate then HF. If NEITHER is set,
# removing GCP_RECONSTRUCTION_URL turns avatar reconstruction OFF. Warn loudly.
if [ -z "${REPLICATE_API_TOKEN:-}" ] && [ -z "${HF_TOKEN:-}" ]; then
  warn "  ⚠ Avatar reconstruct/rerig: neither REPLICATE_API_TOKEN nor HF_TOKEN is set in this shell."
  warn "    After revert, api/_lib/regen-provider.js resolveProviderName() returns 'none' and"
  warn "    avatar reconstruction stops working. Set REPLICATE_API_TOKEN (or HF_TOKEN) in Vercel"
  warn "    BEFORE removing GCP_RECONSTRUCTION_URL. (This check reads THIS shell — verify prod env too.)"
else
  ok   "  ✓ Avatar reconstruct/rerig has a non-GCP fallback available (Replicate and/or HF)."
fi
# Forge image→3D falls back to the free NIM/HF lanes; sketch/remesh just turn off.
if [ -z "${NVIDIA_API_KEY:-}" ] && [ -z "${HF_TOKEN:-}" ] && [ -z "${REPLICATE_API_TOKEN:-}" ]; then
  warn "  ⚠ Forge image→3D: no NVIDIA_API_KEY, HF_TOKEN, or REPLICATE_API_TOKEN in this shell —"
  warn "    after revert there is no image→3D engine at all. Configure at least NVIDIA_API_KEY (free)."
else
  ok   "  ✓ Forge image→3D has a non-GCP engine available (free NIM/HF and/or Replicate)."
fi
if [ -z "${NVIDIA_API_KEY:-}" ] && [ -z "${REPLICATE_API_TOKEN:-}" ]; then
  warn "  ⚠ Imagen text→image: no NVIDIA_API_KEY (free FLUX) or REPLICATE_API_TOKEN backstop —"
  warn "    after revert, image synthesis for text prompts has no provider. Set NVIDIA_API_KEY."
else
  ok   "  ✓ Imagen text→image has a non-GCP provider available (free NIM FLUX and/or Replicate)."
fi
echo
dim "  Sketch→3D (GCP_TRIPOSG_URL) and Game-Ready remesh (GCP_REMESH_URL) have no non-GCP"
dim "  equivalent — reverting simply hides those two options from the forge catalog. No error;"
dim "  the UI stops advertising them (backendIsConfigured / outputIsConfigured return false)."
echo

# ── Step 2: the prod env removals (printed — run these yourself) ───────────────
bold "2) Remove the GCP env gates from production (Cloud Run — the live deploy target)"
echo
dim "   Primary: Cloud Run env lives on three-ws-api directly — no redeploy needed, a"
dim "   '--remove-env-vars'/'--remove-secrets' update takes effect on the next revision"
dim "   immediately (seconds, not a rebuild). Also prints the legacy 'vercel env rm' form"
dim "   in case anything not yet decommissioned there still reads it."
echo
print_rm() {
  local group_label="$1"; shift
  local env_only=() secret_only=()
  for v in "$@"; do
    if [ "$v" = "GCP_SERVICE_ACCOUNT_JSON" ] || [ "$v" = "GCP_RECONSTRUCTION_KEY" ] || [ "$v" = "GCP_BUDGET_WEBHOOK_SECRET" ]; then
      secret_only+=("$v")
    else
      env_only+=("$v")
    fi
  done
  echo "   # ${group_label}"
  if [ "${#env_only[@]}" -gt 0 ]; then
    printf '   gcloud run services update three-ws-api --region us-central1 --project "$PROJECT_ID" \\\n'
    printf '     --remove-env-vars=%s\n' "$(IFS=,; echo "${env_only[*]}")"
  fi
  if [ "${#secret_only[@]}" -gt 0 ]; then
    printf '   gcloud run services update three-ws-api --region us-central1 --project "$PROJECT_ID" \\\n'
    printf '     --remove-secrets=%s\n' "$(IFS=,; echo "${secret_only[*]}")"
  fi
  for v in "$@"; do
    printf '   vercel env rm %s production   # legacy — see note above\n' "$v"
    printf '   vercel env rm %s preview      # legacy — see note above\n' "$v"
  done
  echo
}
print_rm "Forge GPU self-host lanes (image→3D, sketch, remesh, avatar reconstruct)" "${FORGE_VARS[@]}"
print_rm "Editing workers (rembg / texture / segment)" "${EDIT_VARS[@]}"
print_rm "Vertex Claude chat/LLM lane (reverts to free Groq→OpenRouter→NVIDIA, paid backstop)" "${LLM_VARS[@]}"
print_rm "Vertex Imagen text→image (reverts to free NIM FLUX, then Replicate)" "${IMAGEN_VARS[@]}"
dim "   Note: GOOGLE_CLOUD_PROJECT gates BOTH Imagen and Vertex-Claude config; removing it above"
dim "   fully de-configures Vertex. The two VERTEX_CLAUDE_* flags alone are enough to revert chat."
echo

# ── Step 3: Cloud Run min-instances → 0 (the only ongoing GPU bill) ───────────
bold "3) Drop every Cloud Run worker to min-instances=0 (stop warm-GPU billing)"
echo
dim "   The deploy scripts (workers/deploy/*.sh) never set --min-instances, so services"
dim "   deploy at Cloud Run's default of 0 (scale-to-zero) already. This step is a belt-and-"
dim "   -suspenders confirm: it is a no-op on a service that is already at 0."
echo

if [ "$APPLY" -eq 1 ]; then
  command -v gcloud >/dev/null 2>&1 || { warn "   gcloud not on PATH — skipping Cloud Run step. Install gcloud or run this half on a machine that has it."; APPLY_CR=0; }
  APPLY_CR="${APPLY_CR:-1}"
  if [ "${APPLY_CR}" -eq 1 ]; then
    if ! gcloud auth print-access-token >/dev/null 2>&1; then
      warn "   gcloud is not authenticated — run 'gcloud auth login'. Skipping Cloud Run step."
    else
      PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
      [ -n "$PROJECT_ID" ] || { warn "   No PROJECT_ID and no active gcloud project — skipping."; PROJECT_ID=""; }
      if [ -n "$PROJECT_ID" ]; then
        echo "   project=$PROJECT_ID region=$REGION"
        if [ "$ASSUME_YES" -ne 1 ]; then
          read -r -p "   Set min-instances=0 on: $SERVICES ? [y/N] " reply
          case "$reply" in y|Y|yes|YES) ;; *) warn "   aborted by user"; exit 0 ;; esac
        fi
        for svc in $SERVICES; do
          if gcloud run services describe "$svc" --region "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
            printf '   → %s: ' "$svc"
            if gcloud run services update "$svc" --region "$REGION" --project "$PROJECT_ID" \
                 --min-instances=0 --quiet >/dev/null 2>&1; then
              ok "min-instances=0"
            else
              warn "update failed (check IAM / service state)"
            fi
          else
            dim "   · $svc: not found in $PROJECT_ID/$REGION — skipping"
          fi
        done
      fi
    fi
  fi
else
  echo "   Would run, for each existing service in [$SERVICES]:"
  echo "     gcloud run services update <svc> --region $REGION --min-instances=0 --quiet"
fi
echo

# ── Step 4: what to verify after ──────────────────────────────────────────────
bold "4) Verify the revert took (no GCP dependency left in the hot path)"
echo
dim "   • curl \"\$SITE/api/forge?catalog=1\" — every backend with a GCP requiresEnv shows"
dim "     configured:false; free NIM/HF lanes show configured:true. UI stops offering GCP lanes."
dim "   • Generate a text→3D (free NIM) and a photo→3D (free HF) — both succeed."
dim "   • Generate an avatar — reconstruct routes to Replicate/HF (check the response provider)."
dim "   • A text→image request returns from nvidia (NIM FLUX), not vertex-ai/*."
dim "   • A chat completion's route.via is a free provider (groq/openrouter/nvidia), not"
dim "     'vertex-anthropic' — confirms VERTEX_CLAUDE_* removal dropped Vertex from the ladder."
dim "   • GCP billing: after min-instances=0 and no traffic, Cloud Run GPU spend trends to \$0."
echo
ok "Revert plan complete. Nothing on three.ws should break — every GCP lane hands off to the"
ok "provider it displaced. Keep the credits' durable output (R2 assets, vanity inventory) — it"
ok "does not depend on any GCP resource. See docs/gcp-credits.md for the keep/kill cost math and"
ok "scripts/gcp/teardown.sh for deleting the (now idle) GCP resources when you're ready."
