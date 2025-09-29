const mysql = require('mysql2/promise');
require('dotenv').config();

async function addMessageUpdatedAtMigration() {
    let pool;

    try {
        // Ensure we always use MYSQL_DATABASE as schema
        const database = process.env.MYSQL_DATABASE || 'whatsapp_bot';

        // Create database connection
        pool = mysql.createPool({
            host: process.env.MYSQL_HOST,
            user: process.env.MYSQL_USER,
            password: process.env.MYSQL_PASSWORD,
            database,
            port: process.env.PORT || 3306,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
        });

        console.log('🔄 Starting migration: Add updated_at column...');

        // Check if updated_at column already exists
        const [columns] = await pool.query(
            `
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'updated_at'
            `,
            [database]
        );

        if (columns.length > 0) {
            console.log('✅ updated_at column already exists in messages table, skipping migration');
            return;
        }

        // Add updated_at column (auto-updates on change)
        await pool.query(`
            ALTER TABLE messages
                ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER is_deleted
        `);

        console.log('✅ Successfully added updated_at column to messages table');

        // Update existing rows just in case
        const [result] = await pool.query(`
            UPDATE messages 
            SET updated_at = NOW() 
            WHERE updated_at IS NULL
        `);

        console.log(`✅ Updated ${result.affectedRows} existing messages with current timestamp`);

    } catch (error) {
        console.error('❌ Migration failed:', error);
        throw error;
    } finally {
        if (pool) {
            await pool.end();
        }
    }
}

// Run migration if executed directly
if (require.main === module) {
    addMessageUpdatedAtMigration()
        .then(() => {
            console.log('🎉 Migration completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('💥 Migration failed:', error);
            process.exit(1);
        });
}

module.exports = addMessageUpdatedAtMigration;
