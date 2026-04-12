#!/bin/bash
set -e

echo "[DEPLOY] Building client..."
cd client
npm install --production=false
npm run build
cd ..

echo "[DEPLOY] Installing server dependencies..."
cd server
npm install
cd ..

echo "[DEPLOY] Starting server..."
node server/server.js
