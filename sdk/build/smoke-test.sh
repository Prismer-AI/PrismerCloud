#!/bin/bash
# smoke-test.sh — Pack SDK artifacts + verify them inside a Docker sandbox
#
# This is the HOST-SIDE orchestrator. It:
#   1. Calls pack.sh to build all artifacts
#   2. Launches a Docker container (linux/amd64)
#   3. Mounts artifacts + sandbox-verify.sh into the container
#   4. Runs sandbox-verify.sh inside
#   5. Reports overall pass/fail
#
# Usage:
#   sdk/build/smoke-test.sh                    # pack + test all
#   sdk/build/smoke-test.sh --scope aip        # pack + test AIP only
#   sdk/build/smoke-test.sh --skip-pack        # test existing artifacts (no rebuild)
#   sdk/build/smoke-test.sh --dry-run          # show what would happen
source "$(dirname "$0")/lib/common.sh"
parse_common_flags "$@"

# ── Parse smoke-test-specific flags ───────────────────────────────
SKIP_PACK=0
for arg in "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"; do
  case "$arg" in --skip-pack) SKIP_PACK=1 ;; esac
done

SANDBOX_IMAGE="${SANDBOX_IMAGE:-docker.prismer.dev/prismer-academic:v5.1-lite}"
SANDBOX_PLATFORM="${SANDBOX_PLATFORM:-linux/amd64}"

log_step "SDK Smoke Test (scope: $SCOPE, skip-pack: $SKIP_PACK)"

# ── Step 1: Pack artifacts ────────────────────────────────────────
if [[ $SKIP_PACK -eq 0 ]]; then
  log_step "Step 1 — Pack Artifacts"
  PACK_CMD=("$BUILD_ROOT/pack.sh" --scope "$SCOPE" --clean --yes)
  if [[ $DRY_RUN -eq 1 ]]; then
    log_dry "Would run: ${PACK_CMD[*]}"
  else
    log_info "Running: ${PACK_CMD[*]}"
    if ! "${PACK_CMD[@]}"; then
      log_error "pack.sh failed — cannot proceed with smoke test"
      exit 1
    fi
    log_success "pack.sh completed"
  fi
else
  log_info "Skipping pack (--skip-pack)"
fi

# ── Step 2: Verify artifacts exist ────────────────────────────────
log_step "Step 2 — Verify Artifacts"

if [[ ! -d "$ARTIFACTS_DIR/npm" ]]; then
  log_error "Artifacts directory missing: $ARTIFACTS_DIR/npm"
  log_error "Run without --skip-pack or run pack.sh first"
  exit 1
fi

npm_count=$(find "$ARTIFACTS_DIR/npm" -type f -name "*.tgz" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$npm_count" -eq 0 ]]; then
  log_error "No .tgz files found in $ARTIFACTS_DIR/npm/"
  log_error "Run without --skip-pack or run pack.sh first"
  exit 1
fi
log_success "Found $npm_count npm tgz file(s)"

# List all artifacts with sizes
log_info "Artifacts:"
find "$ARTIFACTS_DIR" -type f 2>/dev/null | sort | while read -r f; do
  size=$(du -h "$f" | cut -f1)
  echo "  $size  $(basename "$f")"
done

# ── Step 3: Ensure Docker image is available ──────────────────────
log_step "Step 3 — Docker Image"

if [[ $DRY_RUN -eq 1 ]]; then
  log_dry "Would check/pull Docker image: $SANDBOX_IMAGE"
else
  check_tool docker
  if docker image inspect "$SANDBOX_IMAGE" &>/dev/null; then
    log_success "Image available locally: $SANDBOX_IMAGE"
  else
    log_info "Pulling image: $SANDBOX_IMAGE"
    if ! docker pull --platform linux/amd64 "$SANDBOX_IMAGE"; then
      log_error "Failed to pull Docker image: $SANDBOX_IMAGE"
      log_error "Set SANDBOX_IMAGE / SANDBOX_PLATFORM env vars to override"
      exit 1
    fi
    log_success "Image pulled: $SANDBOX_IMAGE"
  fi
fi

# ── Step 4: Run sandbox verification ──────────────────────────────
log_step "Step 4 — Run Sandbox Verification"

VERIFY_SCRIPT="$BUILD_ROOT/sandbox-verify.sh"
if [[ ! -f "$VERIFY_SCRIPT" ]]; then
  log_error "sandbox-verify.sh not found at: $VERIFY_SCRIPT"
  exit 1
fi

DOCKER_CMD=(docker run --rm)
if [[ -n "$SANDBOX_PLATFORM" ]]; then
  DOCKER_CMD+=(--platform "$SANDBOX_PLATFORM")
fi
DOCKER_CMD+=(
  -v "$ARTIFACTS_DIR:/artifacts:ro"
  -v "$VERIFY_SCRIPT:/verify.sh:ro"
  "$SANDBOX_IMAGE"
  bash /verify.sh
)

if [[ $DRY_RUN -eq 1 ]]; then
  log_dry "Would run: ${DOCKER_CMD[*]}"
  echo ""
  log_success "Dry run complete — no actions taken"
  exit 0
fi

log_info "Running: docker run --rm ${SANDBOX_PLATFORM:+--platform $SANDBOX_PLATFORM }\\"
log_info "  -v $ARTIFACTS_DIR:/artifacts:ro \\"
log_info "  -v $VERIFY_SCRIPT:/verify.sh:ro \\"
log_info "  $SANDBOX_IMAGE bash /verify.sh"
echo ""

"${DOCKER_CMD[@]}"
CONTAINER_EXIT=$?

# ── Step 5: Report results ────────────────────────────────────────
echo ""
log_step "Smoke Test Result"

if [[ $CONTAINER_EXIT -eq 0 ]]; then
  log_success "All sandbox checks passed"
  echo ""
  log_info "Next steps:"
  log_info "  1. sdk/build/install-local.sh --skip-pack   # optional installer re-check"
  log_info "  2. sdk/build/release.sh --scope $SCOPE      # sync + publish"
else
  log_error "Sandbox verification failed (exit code: $CONTAINER_EXIT)"
  log_error "Fix the issues above, then re-run:"
  log_error "  sdk/build/smoke-test.sh --scope $SCOPE"
fi

exit $CONTAINER_EXIT
