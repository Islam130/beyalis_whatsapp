#!/bin/bash

echo "🔧 WhatsApp Bot Session Conflict Fix"
echo "====================================="
echo ""

# Check if auth directory exists
if [ -d "auth_info_baileys" ]; then
    echo "📁 Found authentication directory: auth_info_baileys"
    echo "🗑️  Removing authentication files..."
    rm -rf auth_info_baileys
    echo "✅ Authentication files removed"
else
    echo "ℹ️  No authentication directory found"
fi

echo ""
echo "📋 NEXT STEPS:"
echo "1. Close WhatsApp Web in your browser (if open)"
echo "2. Stop any other bot instances"
echo "3. Run: node index.js"
echo "4. Scan the QR code when it appears"
echo ""
echo "💡 TIP: Only run one WhatsApp bot instance at a time!"
echo ""
