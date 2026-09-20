#!/usr/bin/env bash
# Deploys the latest code from GitHub on the EC2 server.
#
#   sudo bash /opt/millmate/deploy/ec2/update.sh
#
# Pulls the branch, reinstalls dependencies, restarts the API and checks that it
# comes back healthy. The database and /etc/millmate.env are never touched.
set -euo pipefail

APP_DIR=/opt/millmate
BRANCH="${BRANCH:-main}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

# The checkout belongs to the millmate user, so run git as that user.
GIT="sudo -u millmate -H git -C $APP_DIR"
OLD="$($GIT rev-parse --short HEAD)"
$GIT fetch --quiet origin "$BRANCH"
$GIT reset --hard --quiet "origin/$BRANCH"
NEW="$($GIT rev-parse --short HEAD)"

sudo -u millmate -H bash -c "cd '$APP_DIR/server' && npm install --omit=dev --no-audit --no-fund"

# Pick up any changes to the service files that came with this version.
install -m 644 "$APP_DIR/deploy/ec2/millmate.service" /etc/systemd/system/millmate.service
install -m 644 "$APP_DIR/deploy/ec2/millmate-backup.service" /etc/systemd/system/millmate-backup.service
install -m 644 "$APP_DIR/deploy/ec2/millmate-backup.timer" /etc/systemd/system/millmate-backup.timer
systemctl daemon-reload

systemctl restart millmate.service

for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:4000/api/health >/dev/null 2>&1; then
    echo "Updated $OLD -> $NEW and the API is healthy."
    exit 0
  fi
  sleep 1
done

echo "The API did not come back after the update. Last log lines:" >&2
journalctl -u millmate -n 30 --no-pager >&2
echo "To go back to the previous version:" >&2
echo "  sudo -u millmate git -C $APP_DIR reset --hard $OLD \\" >&2
echo "    && sudo -u millmate -H bash -c 'cd $APP_DIR/server && npm install --omit=dev' && sudo systemctl restart millmate" >&2
exit 1
