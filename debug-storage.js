#!/usr/bin/env node

const database = require('./config/database');
const sessionManager = require('./services/sessionManager');

async function debugStorage() {
    console.log('🔍 WhatsApp Bot Storage Debug');
    console.log('============================\n');

    try {
        // Check database connection
        console.log('1. Database Connection Test:');
        await database.pool.execute('SELECT 1');
        console.log('✅ Database connection working\n');

        // Check if tables exist
        console.log('2. Table Existence Check:');
        const tables = ['sessions', 'chats', 'messages'];
        for (const table of tables) {
            try {
                await database.pool.execute(`SELECT COUNT(*) as count FROM ${table}`);
                console.log(`✅ Table '${table}' exists`);
            } catch (error) {
                console.log(`❌ Table '${table}' missing: ${error.message}`);
            }
        }
        console.log('');

        // Check current session
        console.log('3. Current Session Check:');
        const currentSession = sessionManager.getCurrentSession();
        console.log('Current session:', currentSession);
        
        if (!currentSession.sessionId) {
            console.log('⚠️ No active session found');
            console.log('💡 This is why messages/chats are not being stored');
        } else {
            console.log('✅ Active session found');
        }
        console.log('');

        // Check for existing sessions in database
        console.log('4. Existing Sessions in Database:');
        try {
            const [sessions] = await database.pool.execute('SELECT * FROM sessions ORDER BY created_at DESC LIMIT 5');
            if (sessions.length > 0) {
                console.log('Found sessions:');
                sessions.forEach(session => {
                    console.log(`  - ID: ${session.id}, Ready: ${session.ready}, Phone: ${session.phone_number}`);
                });
            } else {
                console.log('No sessions found in database');
            }
        } catch (error) {
            console.log('❌ Error checking sessions:', error.message);
        }
        console.log('');

        // Check for existing chats
        console.log('5. Existing Chats in Database:');
        try {
            const [chats] = await database.pool.execute('SELECT * FROM chats ORDER BY created_at DESC LIMIT 5');
            if (chats.length > 0) {
                console.log('Found chats:');
                chats.forEach(chat => {
                    console.log(`  - ID: ${chat.id}, Name: ${chat.name}, Session: ${chat.session_id}`);
                });
            } else {
                console.log('No chats found in database');
            }
        } catch (error) {
            console.log('❌ Error checking chats:', error.message);
        }
        console.log('');

        // Check for existing messages
        console.log('6. Existing Messages in Database:');
        try {
            const [messages] = await database.pool.execute('SELECT * FROM messages ORDER BY created_at DESC LIMIT 5');
            if (messages.length > 0) {
                console.log('Found messages:');
                messages.forEach(msg => {
                    console.log(`  - ID: ${msg.id}, Body: ${msg.body?.substring(0, 50)}..., Session: ${msg.session_id}`);
                });
            } else {
                console.log('No messages found in database');
            }
        } catch (error) {
            console.log('❌ Error checking messages:', error.message);
        }

        console.log('\n📋 Summary:');
        console.log('===========');
        console.log('If you see "No active session found" above, that\'s why messages/chats aren\'t being stored.');
        console.log('The bot needs to:');
        console.log('1. Generate a QR code (creates session)');
        console.log('2. Have the QR code scanned (marks session as ready)');
        console.log('3. Then messages and chats will be stored');

    } catch (error) {
        console.log('❌ Debug failed:', error.message);
    }
}

debugStorage().catch(console.error);
