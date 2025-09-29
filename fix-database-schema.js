#!/usr/bin/env node

const mysql = require('mysql2/promise');

async function fixDatabaseSchema() {
    console.log('🔧 Fixing Database Schema');
    console.log('========================\n');

    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || 'root@1234',
        database: process.env.DB_NAME || 'mawared',
        port: process.env.DB_PORT || 3306
    });

    try {
        // Check current schema
        console.log('1. Checking current table schemas...');
        
        // Check messages table
        const [messagesColumns] = await connection.execute(`
            SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, COLUMN_DEFAULT
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = '${process.env.DB_NAME || 'mawared'}' 
            AND TABLE_NAME = 'messages'
            ORDER BY ORDINAL_POSITION
        `);
        
        console.log('Messages table columns:');
        messagesColumns.forEach(col => {
            console.log(`  - ${col.COLUMN_NAME}: ${col.DATA_TYPE}(${col.CHARACTER_MAXIMUM_LENGTH || 'N/A'}) ${col.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL'}`);
        });
        console.log('');

        // Check if status column exists and its size
        const statusColumn = messagesColumns.find(col => col.COLUMN_NAME === 'status');
        if (statusColumn) {
            console.log(`Status column found: ${statusColumn.DATA_TYPE}(${statusColumn.CHARACTER_MAXIMUM_LENGTH})`);
            
            if (statusColumn.CHARACTER_MAXIMUM_LENGTH < 50) {
                console.log('⚠️ Status column is too small, fixing...');
                await connection.execute('ALTER TABLE messages MODIFY COLUMN status VARCHAR(100) DEFAULT "received"');
                console.log('✅ Status column updated to VARCHAR(100)');
            } else {
                console.log('✅ Status column size is adequate');
            }
        } else {
            console.log('❌ Status column not found, adding...');
            await connection.execute('ALTER TABLE messages ADD COLUMN status VARCHAR(100) DEFAULT "received"');
            console.log('✅ Status column added');
        }

        // Check other potential issues
        console.log('\n2. Checking for other potential issues...');
        
        // Check if all required columns exist
        const requiredColumns = [
            'id', 'chat_id', 'session_id', 'from_number', 'sender_id', 'sender_name',
            'body', 'timestamp', 'from_me', 'has_media', 'media_type', 'whatsapp_message_id',
            'media_preview', 'parent_id', 'status'
        ];

        const existingColumns = messagesColumns.map(col => col.COLUMN_NAME);
        const missingColumns = requiredColumns.filter(col => !existingColumns.includes(col));

        if (missingColumns.length > 0) {
            console.log('❌ Missing columns:', missingColumns);
            console.log('💡 You may need to recreate the messages table');
        } else {
            console.log('✅ All required columns exist');
        }

        // Test insert with proper data
        console.log('\n3. Testing message insert...');
        try {
            const testMessageData = {
                id: 'test_' + Date.now(),
                chatId: 'test_chat',
                sessionId: 1,
                fromNumber: '1234567890',
                senderId: '1234567890@s.whatsapp.net',
                senderName: 'Test User',
                body: 'Test message',
                timestamp: Date.now(),
                fromMe: 0,
                hasMedia: 0,
                mediaType: null,
                whatsappMessageId: 'test_whatsapp_id',
                mediaPreview: null,
                parentId: null,
                status: 'received'
            };

            await connection.execute(`
                INSERT INTO messages (
                    id, chat_id, session_id, from_number, sender_id, sender_name, body, timestamp,
                    from_me, has_media, media_type, whatsapp_message_id, media_preview, parent_id, status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
            `, [
                testMessageData.id, testMessageData.chatId, testMessageData.sessionId,
                testMessageData.fromNumber, testMessageData.senderId, testMessageData.senderName,
                testMessageData.body, testMessageData.timestamp, testMessageData.fromMe,
                testMessageData.hasMedia, testMessageData.mediaType, testMessageData.whatsappMessageId,
                testMessageData.mediaPreview, testMessageData.parentId, testMessageData.status
            ]);

            console.log('✅ Test message insert successful');
            
            // Clean up test data
            await connection.execute('DELETE FROM messages WHERE id = ?', [testMessageData.id]);
            console.log('✅ Test data cleaned up');

        } catch (error) {
            console.log('❌ Test insert failed:', error.message);
            console.log('💡 This indicates a schema issue that needs manual fixing');
        }

        console.log('\n🎉 Database schema check completed!');

    } catch (error) {
        console.log('❌ Schema fix failed:', error.message);
    } finally {
        await connection.end();
    }
}

fixDatabaseSchema().catch(console.error);
