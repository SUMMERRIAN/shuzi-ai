#!/usr/bin/env bash
set -u

APP_DIR="${APP_DIR:-/var/www/shuzi-ai}"
DOMAIN_URL="${DOMAIN_URL:-https://xyshuziai.com}"
ENV_FILE="$APP_DIR/.env"

if [ ! -d "$APP_DIR" ]; then
  printf '[FAIL] App directory does not exist: %s\n' "$APP_DIR"
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  printf '[FAIL] .env does not exist: %s\n' "$ENV_FILE"
  printf 'Create it first, then rerun this script.\n'
  exit 1
fi

backup_file="$ENV_FILE.backup.$(date +%Y%m%d-%H%M%S)"
cp "$ENV_FILE" "$backup_file"
printf '[OK] Backed up .env to %s\n' "$backup_file"

env_get() {
  key="$1"
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | sed 's/^"//;s/"$//;s/^'\''//;s/'\''$//'
}

is_placeholder() {
  value="$1"
  printf '%s' "$value" | grep -Eiq 'change|your_|your-|please|example|test|demo|password|secret|token|admin|请|改成|这里|默认'
}

set_env() {
  key="$1"
  value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

random_hex() {
  bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    tr -dc 'a-f0-9' </dev/urandom | head -c $((bytes * 2))
    printf '\n'
  fi
}

random_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr -dc 'A-Za-z0-9_@#%+=.-' | head -c 28
    printf '\n'
  else
    tr -dc 'A-Za-z0-9_@#%+=.-' </dev/urandom | head -c 28
    printf '\n'
  fi
}

ensure_secret() {
  key="$1"
  min_len="$2"
  generator="$3"
  current="$(env_get "$key")"
  if [ -z "$current" ] || is_placeholder "$current" || [ "${#current}" -lt "$min_len" ]; then
    if [ "$generator" = "password" ]; then
      next="$(random_password)"
    else
      next="$(random_hex 48)"
    fi
    set_env "$key" "$next"
    printf '[UPDATED] %s was missing/weak and has been replaced.\n' "$key"
    if [ "$key" = "ADMIN_PASSWORD" ]; then
      printf '[IMPORTANT] New ADMIN_PASSWORD: %s\n' "$next"
      printf '[IMPORTANT] Save this password securely now. It is not stored anywhere except .env.\n'
    fi
  else
    printf '[OK] %s already looks strong; kept existing value.\n' "$key"
  fi
}

set_env "CORS_ORIGIN" "$DOMAIN_URL"
printf '[UPDATED] CORS_ORIGIN=%s\n' "$DOMAIN_URL"

set_env "OPENAI_IMAGE_GENERATION_ENABLED" "true"
printf '[UPDATED] OPENAI_IMAGE_GENERATION_ENABLED=true\n'

ensure_secret "JWT_SECRET" 48 "hex"
ensure_secret "ADMIN_SETUP_TOKEN" 48 "hex"
ensure_secret "ADMIN_PASSWORD" 16 "password"

chmod 600 "$ENV_FILE" 2>/dev/null || true
printf '[OK] Applied chmod 600 to .env when permitted.\n'

printf '\nNext steps:\n'
printf '1. Check that DATABASE_URL, OPENAI_API_KEY and GEMINI_API_KEY are real production values.\n'
printf '2. Restart API: systemctl restart shuzi-ai-api\n'
printf '3. Run: bash scripts/production-preflight.sh\n'
