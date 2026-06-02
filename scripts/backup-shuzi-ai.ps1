param(
  [string]$Server = "root@5.223.91.77",
  [string]$RemoteAppDir = "/var/www/shuzi-ai",
  [string]$RemoteBackupRoot = "/root/shuzi-ai-backups",
  [string]$BackupRoot = ""
)

$ErrorActionPreference = "Stop"

function Resolve-BackupRoot {
  param([string]$RequestedRoot)

  if ($RequestedRoot) {
    return $RequestedRoot
  }

  $candidates = @(
    "I:\Google Drive\ShuziAI-Backups",
    "G:\My Drive\ShuziAI-Backups",
    "$env:USERPROFILE\Google Drive\ShuziAI-Backups",
    "$env:USERPROFILE\My Drive\ShuziAI-Backups",
    "$env:USERPROFILE\Desktop\ShuziAI-Backups"
  )

  foreach ($candidate in $candidates) {
    $parent = Split-Path -Parent $candidate
    if (Test-Path $candidate -PathType Container) {
      return $candidate
    }
    if ($parent -and (Test-Path $parent -PathType Container)) {
      return $candidate
    }
  }

  return "$env:USERPROFILE\Desktop\ShuziAI-Backups"
}

function Assert-Command {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Command not found: $Name. Please install or enable Windows OpenSSH Client."
  }
}

Assert-Command "ssh"
Assert-Command "scp"

$BackupRoot = Resolve-BackupRoot $BackupRoot
New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dbFileName = "shuzi-ai-db-$stamp.dump"
$uploadsFileName = "shuzi-ai-uploads-$stamp.tar.gz"
$manifestFileName = "SHA256SUMS-$stamp.txt"

$remoteScript = @'
set -euo pipefail

APP_DIR="${REMOTE_APP_DIR:-/var/www/shuzi-ai}"
BACKUP_ROOT="${REMOTE_BACKUP_ROOT:-/root/shuzi-ai-backups}"
STAMP="${BACKUP_STAMP:-$(date +%Y%m%d-%H%M%S)}"

DB_FILE="$BACKUP_ROOT/shuzi-ai-db-$STAMP.dump"
UPLOADS_FILE="$BACKUP_ROOT/shuzi-ai-uploads-$STAMP.tar.gz"
MANIFEST_FILE="$BACKUP_ROOT/SHA256SUMS-$STAMP.txt"

mkdir -p "$BACKUP_ROOT"
cd "$APP_DIR"

if [ ! -f ".env" ]; then
  echo "ERROR: $APP_DIR/.env not found. Cannot read DATABASE_URL."
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ERROR: pg_dump not found on server."
  exit 1
fi

DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | tail -n 1 | cut -d= -f2- || true)"
UPLOAD_DIR="$(grep -E '^UPLOAD_DIR=' .env | tail -n 1 | cut -d= -f2- || true)"

DATABASE_URL="${DATABASE_URL%\"}"
DATABASE_URL="${DATABASE_URL#\"}"
DATABASE_URL="${DATABASE_URL%\'}"
DATABASE_URL="${DATABASE_URL#\'}"

UPLOAD_DIR="${UPLOAD_DIR%\"}"
UPLOAD_DIR="${UPLOAD_DIR#\"}"
UPLOAD_DIR="${UPLOAD_DIR%\'}"
UPLOAD_DIR="${UPLOAD_DIR#\'}"

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is missing in .env."
  exit 1
fi

if [ -z "$UPLOAD_DIR" ]; then
  UPLOAD_DIR="$APP_DIR/uploads"
fi

echo "1/3 Backing up PostgreSQL database..."
pg_dump --format=custom --no-owner --no-privileges --file "$DB_FILE" "$DATABASE_URL"

echo "2/3 Archiving uploads directory..."
if [ -d "$UPLOAD_DIR" ]; then
  UPLOAD_PARENT="$(dirname "$UPLOAD_DIR")"
  UPLOAD_BASE="$(basename "$UPLOAD_DIR")"
  tar -czf "$UPLOADS_FILE" -C "$UPLOAD_PARENT" "$UPLOAD_BASE"
else
  TEMP_EMPTY_DIR="$(mktemp -d)"
  echo "UPLOAD_DIR not found: $UPLOAD_DIR" > "$TEMP_EMPTY_DIR/README.txt"
  tar -czf "$UPLOADS_FILE" -C "$TEMP_EMPTY_DIR" README.txt
  rm -rf "$TEMP_EMPTY_DIR"
fi

echo "3/3 Creating checksum file..."
cd "$BACKUP_ROOT"
sha256sum "$(basename "$DB_FILE")" "$(basename "$UPLOADS_FILE")" > "$MANIFEST_FILE"

find "$BACKUP_ROOT" -type f \( -name 'shuzi-ai-db-*.dump' -o -name 'shuzi-ai-uploads-*.tar.gz' -o -name 'SHA256SUMS-*.txt' \) -mtime +7 -delete

echo "REMOTE_DB_FILE=$DB_FILE"
echo "REMOTE_UPLOADS_FILE=$UPLOADS_FILE"
echo "REMOTE_MANIFEST_FILE=$MANIFEST_FILE"
echo "Remote backup files are ready."
'@

$tempScript = New-TemporaryFile
try {
  Set-Content -LiteralPath $tempScript -Value $remoteScript -Encoding UTF8

  Write-Host "Connecting to server and creating backup: $Server"
  Get-Content -LiteralPath $tempScript -Raw | & ssh $Server "BACKUP_STAMP=$stamp REMOTE_APP_DIR=$RemoteAppDir REMOTE_BACKUP_ROOT=$RemoteBackupRoot bash -s"
  if ($LASTEXITCODE -ne 0) {
    throw "Remote backup command failed."
  }

  Write-Host "Downloading backup files to: $BackupRoot"
  & scp "${Server}:$RemoteBackupRoot/$dbFileName" "$BackupRoot\"
  if ($LASTEXITCODE -ne 0) { throw "Database backup download failed." }

  & scp "${Server}:$RemoteBackupRoot/$uploadsFileName" "$BackupRoot\"
  if ($LASTEXITCODE -ne 0) { throw "Uploads backup download failed." }

  & scp "${Server}:$RemoteBackupRoot/$manifestFileName" "$BackupRoot\"
  if ($LASTEXITCODE -ne 0) { throw "Checksum file download failed." }

  Write-Host ""
  Write-Host "Backup completed:"
  Write-Host "Database: $BackupRoot\$dbFileName"
  Write-Host "Uploads: $BackupRoot\$uploadsFileName"
  Write-Host "Checksum: $BackupRoot\$manifestFileName"
  Write-Host ""
  Write-Host "If this folder is inside Google Drive, Google Drive will sync it to the cloud."
} finally {
  Remove-Item -LiteralPath $tempScript -Force -ErrorAction SilentlyContinue
}
