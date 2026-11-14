#!/usr/bin/env bash
# Usage: source ./run1.sh
# Student portal on http://localhost:3000.

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR" || { echo "Could not enter $PROJECT_DIR"; return 1 2>/dev/null || exit 1; }

if [ ! -d node_modules ]; then
  echo "Installing npm dependencies..."
  npm install || { echo "npm install failed"; return 1 2>/dev/null || exit 1; }
fi

echo "Starting PostgreSQL..."
npm run db:start || { echo "Could not start PostgreSQL"; return 1 2>/dev/null || exit 1; }

echo "Checking the database..."
if node scripts/seed-if-empty.js; then
  echo "Using existing data."
else
  echo "Empty database; seeding 25 base cases..."
  npm run seed || { echo "Seeding failed"; return 1 2>/dev/null || exit 1; }
fi

echo "Adding the extra 25 cases if missing..."
npm run add-cases || { echo "Adding cases failed"; return 1 2>/dev/null || exit 1; }

echo "Adding the 24 meeting cases if missing..."
npm run add-meeting-cases || { echo "Adding meeting cases failed"; return 1 2>/dev/null || exit 1; }

echo ""
echo "Student portal: http://localhost:3000"
echo "Login:          student1 / 1234"
echo "Press Ctrl+C to stop."
echo ""

PORT=3000 SESSION_COOKIE_NAME=ayadvi.sid.3000 npm start
