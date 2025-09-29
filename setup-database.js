#!/usr/bin/env node

const mysql = require('mysql2/promise');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(prompt) {
    return new Promise((resolve) => {
        rl.question(prompt, resolve);
    });
}

async function setupDatabase() {
    console.log('🗄️  WhatsApp Bot Database Setup');
    console.log('===============================\n');

    try {
        // Get database credentials
        const host = await question('Database Host (localhost): ') || 'localhost';
        const user = await question('Database User (root): ') || 'root';
        const password = await question('Database Password: ');
        const database = await question('Database Name (whatsapp_bot): ') || 'whatsapp_bot';
        const port = await question('Database Port (3306): ') || '3306';

        console.log('\n🔄 Testing connection...');

        // Test connection
        const connection = await mysql.createConnection({
            host: host,
            user: user,
            password: password,
            port: parseInt(port)
        });

        console.log('✅ Connection successful!');

        // Create database if it doesn't exist
        await connection.execute(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
        console.log(`✅ Database '${database}' created/verified`);

        // Use the database
        await connection.execute(`USE \`${database}\``);

        // Create tables
        console.log('\n📋 Creating tables...');

        // Sessions table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS sessions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                qr TEXT,
                ready TINYINT(1) DEFAULT 0,
                phone_number VARCHAR(191),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Sessions table created');

        // Chats table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS chats (
                id VARCHAR(255) PRIMARY KEY,
                session_id INT,
                name VARCHAR(255),
                phone_number LONGTEXT,
                is_group TINYINT(1) DEFAULT 0,
                last_message_id VARCHAR(255),
                last_message_timestamp BIGINT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES sessions(id)
            )
        `);
        console.log('✅ Chats table created');

        // Messages table
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS messages (
                id VARCHAR(255) PRIMARY KEY,
                chat_id VARCHAR(255),
                session_id INT,
                from_number VARCHAR(255),
                sender_id VARCHAR(255),
                sender_name VARCHAR(255),
                body TEXT,
                timestamp BIGINT,
                from_me TINYINT(1) DEFAULT 0,
                has_media TINYINT(1) DEFAULT 0,
                media_type VARCHAR(50),
                whatsapp_message_id VARCHAR(255),
                is_deleted TINYINT(1) DEFAULT 0,
                deleted_at TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                media_preview TEXT,
                parent_id VARCHAR(191),
                status VARCHAR(50) DEFAULT 'received',
                FOREIGN KEY (chat_id) REFERENCES chats(id),
                FOREIGN KEY (session_id) REFERENCES sessions(id)
            )
        `);
        console.log('✅ Messages table created');

        await connection.end();

        // Generate .env content
        const envContent = `# Database Configuration
DB_HOST=${host}
DB_USER=${user}
DB_PASSWORD=${password}
DB_NAME=${database}
DB_PORT=${port}

# AWS S3 Configuration (optional)
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=us-east-1
S3_BUCKET_NAME=whatsapp-media-bucket

# Optional: WhatsApp Bot Configuration
BOT_NAME=WhatsApp Bot
BOT_VERSION=1.0.0`;

        console.log('\n📝 .env file content:');
        console.log('====================');
        console.log(envContent);
        console.log('\n💡 Save this content to a .env file in your project root');

        console.log('\n🎉 Database setup completed successfully!');
        console.log('🚀 You can now run: npm start');

    } catch (error) {
        console.log('❌ Setup failed!');
        console.log(`   Error: ${error.message}`);
        console.log('\n🔧 Please check your database credentials and try again');
    } finally {
        rl.close();
    }
}

setupDatabase().catch(console.error);
