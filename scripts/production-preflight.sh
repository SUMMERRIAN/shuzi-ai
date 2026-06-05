#!/usr/bin/env bash
set -u

APP_DIR="${APP_DIR:-/var/www/shuzi-ai}"
DOMAIN_URL="${DOMAIN_URL:-https://xyshuziai.com}"
DOMAIN_HOST="${DOMAIN_HOST:-xyshuziai.com}"
SERVICE_NAME="${SERVICE_NAME:-shuzi-ai-api}"

fail_count=0
warn_count=0

ok() {
  printf '[OK] %s\n' "$1"
}

warn() {
  warn_count=$((warn_count + 1))
  printf '[WARN] %s\n' "$1"
}

fail() {
  fail_count=$((fail_count + 1))
  printf '[FAIL] %s\n' "$1"
}

env_get() {
  key="$1"
  if [ ! -f "$APP_DIR/.env" ]; then
    return 0
  fi
  grep -E "^${key}=" "$APP_DIR/.env" | tail -n 1 | cut -d= -f2- | sed 's/^"//;s/"$//;s/^'\''//;s/'\''$//'
}

is_placeholder() {
  value="$1"
  printf '%s' "$value" | grep -Eiq 'change|your_|your-|please|example|test|demo|password|secret|token|admin|请|改成|这里|默认'
}

check_required() {
  key="$1"
  value="$(env_get "$key")"
  if [ -z "$value" ]; then
    fail "$key is missing in .env"
  elif is_placeholder "$value"; then
    fail "$key looks like a placeholder"
  else
    ok "$key is set"
  fi
}

check_secret() {
  key="$1"
  min_len="$2"
  value="$(env_get "$key")"
  if [ -z "$value" ]; then
    fail "$key is missing in .env"
    return
  fi
  if is_placeholder "$value"; then
    fail "$key looks like a placeholder"
    return
  fi
  length=${#value}
  if [ "$length" -lt "$min_len" ]; then
    warn "$key is set but short; recommended length is at least $min_len characters"
  else
    ok "$key length looks acceptable"
  fi
}

run_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    "$@"
  fi
}

printf 'Shuzi AI production preflight\n'
printf 'App dir: %s\n' "$APP_DIR"
printf 'Domain: %s\n\n' "$DOMAIN_URL"

if [ ! -d "$APP_DIR" ]; then
  fail "App directory does not exist: $APP_DIR"
else
  ok "App directory exists"
fi

if [ ! -f "$APP_DIR/.env" ]; then
  fail ".env is missing: $APP_DIR/.env"
else
  ok ".env exists"
  env_perm="$(stat -c '%a' "$APP_DIR/.env" 2>/dev/null || true)"
  if [ -n "$env_perm" ] && [ "$env_perm" -gt 640 ]; then
    warn ".env permission is $env_perm; recommended: chmod 600 $APP_DIR/.env"
  else
    ok ".env permission is not overly broad"
  fi
fi

check_required "DATABASE_URL"
check_secret "JWT_SECRET" 48
check_secret "ADMIN_SETUP_TOKEN" 48
check_secret "ADMIN_PASSWORD" 16
check_required "OPENAI_API_KEY"

gemini_key="$(env_get "GEMINI_API_KEY")"
if [ -z "$gemini_key" ] || is_placeholder "$gemini_key"; then
  warn "GEMINI_API_KEY is missing or placeholder; mistake/no-answer Gemini routes may not work"
else
  ok "GEMINI_API_KEY is set"
fi

cors_origin="$(env_get "CORS_ORIGIN")"
if [ "$cors_origin" = "$DOMAIN_URL" ]; then
  ok "CORS_ORIGIN matches $DOMAIN_URL"
else
  fail "CORS_ORIGIN should be $DOMAIN_URL, current value: ${cors_origin:-empty}"
fi

image_enabled="$(env_get "OPENAI_IMAGE_GENERATION_ENABLED")"
if [ "$image_enabled" = "true" ]; then
  ok "OPENAI_IMAGE_GENERATION_ENABLED=true"
else
  warn "OPENAI_IMAGE_GENERATION_ENABLED is not true; knowledge image generation will return 503"
fi

port="$(env_get "PORT")"
if [ -z "$port" ]; then
  port="3001"
fi

if [ -f "$APP_DIR/dist/index.html" ]; then
  ok "Frontend build exists: dist/index.html"
else
  fail "Frontend build is missing; run: cd $APP_DIR && npm run build"
fi

if [ -d "$APP_DIR/node_modules" ]; then
  ok "node_modules exists"
else
  warn "node_modules is missing; run: cd $APP_DIR && npm install"
fi

if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "systemd service is active: $SERVICE_NAME"
  else
    fail "systemd service is not active: $SERVICE_NAME"
    systemctl status "$SERVICE_NAME" --no-pager -l 2>/dev/null | tail -n 20 || true
  fi
else
  warn "systemctl is not available; skipped service check"
fi

if command -v nginx >/dev/null 2>&1; then
  if run_sudo nginx -t >/tmp/shuzi-nginx-test.log 2>&1; then
    ok "nginx -t passed"
  else
    fail "nginx -t failed"
    cat /tmp/shuzi-nginx-test.log
  fi

  nginx_dump="$(run_sudo nginx -T 2>/dev/null || true)"
  if printf '%s' "$nginx_dump" | grep -q "$APP_DIR/dist"; then
    ok "nginx config references frontend dist"
  else
    warn "nginx config does not clearly reference $APP_DIR/dist"
  fi
  if printf '%s' "$nginx_dump" | grep -q "location /api" && printf '%s' "$nginx_dump" | grep -q "127.0.0.1:${port}"; then
    ok "nginx config appears to proxy /api to 127.0.0.1:$port"
  else
    fail "nginx config should proxy /api to http://127.0.0.1:$port"
  fi
else
  fail "nginx is not installed or not in PATH"
fi

if command -v curl >/dev/null 2>&1; then
  if curl -fsS "http://127.0.0.1:${port}/api/health" >/tmp/shuzi-local-health.json 2>/tmp/shuzi-local-health.err; then
    ok "local API health passed: http://127.0.0.1:${port}/api/health"
  else
    fail "local API health failed: http://127.0.0.1:${port}/api/health"
    cat /tmp/shuzi-local-health.err 2>/dev/null || true
  fi

  if curl -fsS "${DOMAIN_URL}/api/health" >/tmp/shuzi-public-health.json 2>/tmp/shuzi-public-health.err; then
    ok "public API health passed: ${DOMAIN_URL}/api/health"
  else
    fail "public API health failed: ${DOMAIN_URL}/api/health"
    cat /tmp/shuzi-public-health.err 2>/dev/null || true
  fi

  if curl -fsSI "$DOMAIN_URL/" >/tmp/shuzi-public-home.headers 2>/tmp/shuzi-public-home.err; then
    ok "public homepage responds: $DOMAIN_URL/"
  else
    fail "public homepage failed: $DOMAIN_URL/"
    cat /tmp/shuzi-public-home.err 2>/dev/null || true
  fi
else
  fail "curl is not installed"
fi

printf '\nSummary: %s fail(s), %s warning(s)\n' "$fail_count" "$warn_count"
if [ "$fail_count" -gt 0 ]; then
  printf 'Result: NOT READY. Fix FAIL items before opening the site.\n'
  exit 1
fi

if [ "$warn_count" -gt 0 ]; then
  printf 'Result: READY WITH WARNINGS. Review warnings, but they may not block launch.\n'
  exit 0
fi

printf 'Result: READY.\n'
