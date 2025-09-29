#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

console.log('🚀 WhatsApp Bot Database Setup');
console.log('===============================\n');

// Check if .env file exists
const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
    console.log('📝 Creating .env file...');
    const envContent = `# Database Configuration
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=whatsapp_bot
DB_PORT=3306

# AWS S3 Configuration
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=us-east-1
S3_BUCKET_NAME=whatsapp-media-bucket

# Optional: WhatsApp Bot Configuration
BOT_NAME=WhatsApp Bot
BOT_VERSION=1.0.0`;

    fs.writeFileSync(envPath, envContent);
    console.log('✅ .env file created');
} else {
    console.log('✅ .env file already exists');
}

// Check if node_modules exists
const nodeModulesPath = path.join(__dirname, 'node_modules');
if (!fs.existsSync(nodeModulesPath)) {
    console.log('\n📦 Installing dependencies...');
    console.log('Run: npm install');
} else {
    console.log('✅ Dependencies already installed');
}

console.log('\n📋 Setup Checklist:');
console.log('1. ✅ .env file created');
console.log('2. 📦 Run: npm install');
console.log('3. 🗄️  Set up MySQL database with required tables');
console.log('4. ☁️  Configure AWS S3 bucket');
console.log('5. 🔧 Update .env file with your credentials');
console.log('6. 🚀 Run: npm start');

console.log('\n📖 See README.md for detailed setup instructions');
console.log('🎯 Ready to start your WhatsApp bot!');
