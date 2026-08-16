#!/bin/bash
# Double-click this file to publish any changes to the live website.
# It saves your changes, sends them to GitHub, and Cloudflare rebuilds the site.

cd "$(dirname "$0")" || exit 1

echo ""
echo "=========================================="
echo "   Publishing Lanaria Studio"
echo "=========================================="
echo ""

# Clear any leftover lock files from an interrupted git run
rm -f .git/index.lock .git/HEAD.lock .git/refs/heads/master.lock .git/objects/maintenance.lock 2>/dev/null

echo "Checking for changes..."
git add -A

if git diff --cached --quiet; then
  echo ""
  echo "  Nothing to publish - the website is already up to date."
  echo ""
  echo "Press any key to close this window."
  read -n 1 -s
  exit 0
fi

echo ""
echo "Changes found:"
git diff --cached --name-only | sed 's/^/   - /'
echo ""

echo "Saving..."
if ! git commit -m "Update site - $(date '+%d %b %Y at %H:%M')" >/dev/null 2>&1; then
  echo ""
  echo "  Could not save the changes. Ask Claude for help and mention 'commit failed'."
  echo ""
  echo "Press any key to close this window."
  read -n 1 -s
  exit 1
fi

echo "Sending to the website..."
if git push >/dev/null 2>&1; then
  echo ""
  echo "  Done. The website is rebuilding now."
  echo "  It will be live in about 90 seconds at:"
  echo "  https://lanaria-studio.delaneycayzer.workers.dev"
  echo ""
else
  echo ""
  echo "  Saved, but could not reach GitHub."
  echo "  Check the internet connection and double-click this again."
  echo "  If it keeps failing, ask Claude and mention 'push failed'."
  echo ""
fi

echo "Press any key to close this window."
read -n 1 -s
