#!/bin/bash
# Applies the three commits from jb-25aug-pm.tar.gz and pushes.
#
# Why this exists: the sandbox that reaches your Mac can't delete files, and git
# can't do anything real without deleting its own lock files. So the last step
# runs in your Terminal, where it can. Everything else is already done.
#
#   bash ~/Desktop/CMOB/01\ Active\ Builds/Jesses\ Bakery\ System\ Build/apply-25aug-pm.sh
#
set -e

REPO="$HOME/Desktop/CMOB/01 Active Builds/Jesses Bakery System Build/jesses-bakery-os"
BALL="$HOME/Desktop/CMOB/01 Active Builds/Jesses Bakery System Build/jb-25aug-pm.tar.gz"

cd "$REPO"

# Clear the half-applied state the sandbox left behind. The only uncommitted
# changes in apps/web are the ones patch 1 reapplies, so nothing of yours is lost.
rm -rf .git/rebase-apply
rm -f .git/*.lock .git/refs/heads/*.lock
git reset --hard HEAD

git fetch origin
git merge --ff-only origin/main

rm -rf /tmp/jbp && mkdir -p /tmp/jbp
tar xzf "$BALL" -C /tmp/jbp
git am --3way /tmp/jbp/*.patch

echo
echo "Applied:"
git log --oneline -4
echo
read -p "Push these to main? [y/N] " ok
[ "$ok" = "y" ] && git push origin main && echo "Pushed. Netlify will redeploy." || echo "Not pushed. Run: git push origin main"
