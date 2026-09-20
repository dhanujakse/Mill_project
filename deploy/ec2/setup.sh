#!/usr/bin/env bash
# One-time setup of the Mill Mate API on a fresh Ubuntu 22.04 / 24.04 EC2 instance.
#
#   git clone https://github.com/ramya25-star/Mill_project.git
#   sudo -E DOMAIN=api.example.com S3_BUCKET=my-bucket SEED_PASSWORD='choose-one' \
#        bash Mill_project/deploy/ec2/setup.sh
#
# Required : DOMAIN     hostname that already points at this server's public IP
#                       (Caddy needs it to get a free HTTPS certificate)
#            S3_BUCKET  bucket for attachments and database backups
# Optional : S3_REGION (ap-south-1), CORS_ORIGIN, SEED_PASSWORD, REPO_URL, BRANCH
#
# Safe to run again: it updates the code and services but never overwrites an
# existing /etc/millmate.env (your JWT secret and settings) or the database.
set -euo pipefail

: "${DOMAIN:?Set DOMAIN, e.g. DOMAIN=api.example.com}"
: "${S3_BUCKET:?Set S3_BUCKET, e.g. S3_BUCKET=millmate-files-1234}"
REPO_URL="${REPO_URL:-https://github.com/ramya25-star/Mill_project.git}"
BRANCH="${BRANCH:-main}"
S3_REGION="${S3_REGION:-ap-south-1}"
CORS_ORIGIN="${CORS_ORIGIN:-https://alagiri-mill.vercel.app,https://localhost,capacitor://localhost}"
APP_DIR=/opt/millmate
DATA_DIR=/var/lib/millmate
ENV_FILE=/etc/millmate.env
GENERATED_PASSWORD=0

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root:  sudo -E DOMAIN=... S3_BUCKET=... bash $0" >&2
  exit 1
fi

echo "==> 1/7 Swap file (small instances run out of memory during npm install)"
if ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> 2/7 System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates gnupg openssl debian-keyring debian-archive-keyring apt-transport-https unattended-upgrades

echo "==> 3/7 Node.js 22 (node:sqlite needs 22.5 or newer)"
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
fi
if [ "$NODE_MAJOR" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> 4/7 Caddy (web server that gets and renews the HTTPS certificate automatically)"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> 5/7 Application user, code and dependencies"
id millmate >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin millmate
mkdir -p "$DATA_DIR"
chown millmate:millmate "$DATA_DIR"
chmod 750 "$DATA_DIR"

# The checkout belongs to the millmate user, so run git as that user (as root, git
# refuses a repository owned by someone else: "dubious ownership").
if [ -d "$APP_DIR/.git" ]; then
  chown -R millmate:millmate "$APP_DIR"
  sudo -u millmate -H git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  sudo -u millmate -H git -C "$APP_DIR" checkout --quiet "$BRANCH"
  sudo -u millmate -H git -C "$APP_DIR" reset --hard --quiet "origin/$BRANCH"
else
  rm -rf "$APP_DIR"
  mkdir -p "$APP_DIR"
  chown millmate:millmate "$APP_DIR"
  sudo -u millmate -H git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
sudo -u millmate -H bash -c "cd '$APP_DIR/server' && npm install --omit=dev --no-audit --no-fund"

echo "==> 6/7 Configuration ($ENV_FILE)"
if [ -f "$ENV_FILE" ]; then
  echo "    $ENV_FILE already exists - leaving it untouched."
else
  umask 077
  if [ -z "${SEED_PASSWORD:-}" ]; then
    # Never fall back to the public default password: make a strong one and show it at the end.
    SEED_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
    GENERATED_PASSWORD=1
  fi
  cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=4000
# Signs login sessions. Never change it, or every user is logged out.
JWT_SECRET=$(openssl rand -hex 48)
DB_PATH=$DATA_DIR/alagiri.db
CORS_ORIGIN=$CORS_ORIGIN
# Files and backups live in S3. No AWS keys here: the instance's IAM role is used.
S3_BUCKET=$S3_BUCKET
S3_REGION=$S3_REGION
# Password for the first admin/employee accounts (only used when the database is created).
SEED_PASSWORD=$SEED_PASSWORD
# WhatsApp Cloud API (optional)
META_ACCESS_TOKEN=
META_PHONE_NUMBER_ID=
META_WEBHOOK_VERIFY_TOKEN=
META_APP_SECRET=
META_AVAILABILITY_TEMPLATE_NAME=
META_TEMPLATE_LANGUAGE=en_US
EOF
  chown root:millmate "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  umask 022   # back to normal: later files (e.g. the Caddy config) must be readable by their services
fi

echo "==> 7/7 Services"
install -m 644 "$APP_DIR/deploy/ec2/millmate.service" /etc/systemd/system/millmate.service
install -m 644 "$APP_DIR/deploy/ec2/millmate-backup.service" /etc/systemd/system/millmate-backup.service
install -m 644 "$APP_DIR/deploy/ec2/millmate-backup.timer" /etc/systemd/system/millmate-backup.timer

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    encode gzip
    request_body {
        max_size 20MB
    }
    reverse_proxy 127.0.0.1:4000
}
EOF

systemctl daemon-reload
systemctl enable --now millmate.service
systemctl enable --now millmate-backup.timer
systemctl enable caddy
systemctl restart caddy

echo
echo "Waiting for the API to start..."
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:4000/api/health >/dev/null 2>&1; then
    echo "API is up."
    break
  fi
  sleep 1
done

echo
if [ "$GENERATED_PASSWORD" = 1 ]; then
  echo "=============================================================="
  echo " First login: username  admin   password  $SEED_PASSWORD"
  echo " (shown once - it is also stored in $ENV_FILE. Change it in the app.)"
  echo "=============================================================="
  echo
fi
echo "Done. Next:"
echo "  1. Check   https://$DOMAIN/api/health   (the first HTTPS request can take a few seconds)"
echo "  2. Logs    sudo journalctl -u millmate -n 30 --no-pager   (expect: File storage: S3 bucket \"$S3_BUCKET\")"
echo "  3. Backup  sudo systemctl start millmate-backup.service && sudo journalctl -u millmate-backup -n 5 --no-pager"
