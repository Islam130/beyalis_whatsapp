const { FSx } = require('aws-sdk');
const mysql = require('mysql2/promise');
const fs = require('fs');
require('dotenv').config();

// Database configuration
const dbConfig = {
    host: process.env.MYSQL_HOST ,
    user: process.env.MYSQL_USER ,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    port: process.env.PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

// Validate database configuration

// Create connection pool
const pool = mysql.createPool(dbConfig);

// Database models
class Database {
    constructor() {
        this.pool = pool;
    }

    // Session operations
    async createSession(qrCode) {
        console.log(qrCode);
        const [result] = await this.pool.execute(
            'INSERT INTO sessions (qr, ready, created_at, updated_at) VALUES (?, 0, NOW(), NOW())',
            [qrCode]
        );
        return result.insertId;
    }

    async updateSessionReady(sessionId, phoneNumber) {
        await this.pool.execute(
            'UPDATE sessions SET ready = 1, phone_number = ?, updated_at = NOW() WHERE id = ?',
            [phoneNumber, sessionId]
        );
    }

    async updateSessionQR(sessionId, qrCode) {
        console.log(`🔍 Database: Updating session ${sessionId} with QR code (${qrCode ? qrCode.length : 'null'} chars)`);
        // console.log(`🔍 Database: QR code full: ${qrCode || 'null'}`);
        console.log(`🔍 Database: QR code type: ${qrCode ? (qrCode.includes('data:image') ? 'data_url' : 'base64_string') : 'null'}`);
        
        const [result] = await this.pool.execute(
            'UPDATE sessions SET qr = ?, updated_at = NOW() WHERE id = ?',
            [qrCode, sessionId]
        );
        console.log(`🔍 Database: Update result - affected rows: ${result.affectedRows}`);
        
        // Verify the update by reading back
        const [verifyRows] = await this.pool.execute(
            'SELECT qr FROM sessions WHERE id = ?',
            [sessionId]
        );
        if (verifyRows.length > 0) {
            const storedQR = verifyRows[0].qr;
            console.log(`🔍 Database: Verification - stored QR length: ${storedQR ? storedQR.length : 'null'}`);
            // console.log(`🔍 Database: Verification - stored QR full: ${storedQR || 'null'}`);
        }
        
        return result;
    }

    async getSession(sessionId) {
        console.log(`🔍 Database: Getting session ${sessionId}`);
        const [rows] = await this.pool.execute(
            'SELECT * FROM sessions WHERE id = ?',
            [sessionId]
        );
        const session = rows[0] || null;
        if (session) {
            console.log(`🔍 Database: Retrieved session - QR length: ${session.qr ? session.qr.length : 'null'}`);
            console.log(`🔍 Database: Retrieved session - QR full: ${session.qr || 'null'}`);
        } else {
            console.log(`🔍 Database: No session found with ID ${sessionId}`);
        }
        return session;
    }

    async getActiveSession() {
        const [rows] = await this.pool.execute(
            'SELECT * FROM sessions WHERE ready = 1 ORDER BY updated_at DESC LIMIT 1'
        );
        return rows[0] || null;
    }

    async getAllReadySessions() {
        const [rows] = await this.pool.execute(
            'SELECT * FROM sessions WHERE ready = 1 ORDER BY updated_at DESC'
        );
        return rows;
    }

    // Chat operations
    async createOrUpdateChat(chatData) {
        const { id, sessionId, name, phoneNumber, isGroup, lastMessageId, lastMessageTimestamp } = chatData;
        
        const [existing] = await this.pool.execute(
            'SELECT id FROM chats WHERE id = ? AND session_id = ?',
            [id, sessionId]
        );

        if (existing.length > 0) {
            // Update existing chat
            await this.pool.execute(
                'UPDATE chats SET name = ?, phone_number = ?, is_group = ?, last_message_id = ?, last_message_timestamp = ?, updated_at = NOW() WHERE id = ? AND session_id = ?',
                [name, phoneNumber, isGroup, lastMessageId, lastMessageTimestamp, id, sessionId]
            );
        } else {
            // Create new chat
            await this.pool.execute(
                'INSERT INTO chats (id, session_id, name, phone_number, is_group, last_message_id, last_message_timestamp, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())',
                [id, sessionId, name, phoneNumber, isGroup, lastMessageId, lastMessageTimestamp]
            );
        }
    }

    async getChat(chatId, sessionId) {
        const [rows] = await this.pool.execute(
            'SELECT * FROM chats WHERE id = ? AND session_id = ?',
            [chatId, sessionId]
        );
        return rows[0] || null;
    }

    // Message operations
    async createMessage(messageData) {
        const {
            id, chatId, sessionId, fromNumber, senderId, senderName, body, timestamp,
            fromMe, hasMedia, mediaType, whatsappMessageId, mediaPreview, parentId, status
        } = messageData;
        console.log('createMessage createMessage createMessage createMessage createMessage createMessage createMessage createMessage');
        // fs.writeFileSync('rowExists.json', JSON.stringify(this.rowExists(id), null, 2));
        // if(! Object.keys(this.rowExists(id)).length === 0){
        //     console.log('Message already exists');
        //     return;
        // }

        if(body ==="" && mediaPreview == null) return;

        await this.pool.execute(
            `INSERT IGNORE INTO messages (
                id, chat_id, session_id, from_number, sender_id, sender_name, body, timestamp,
                from_me, has_media, media_type, whatsapp_message_id, media_preview, parent_id, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
            [
                id, chatId, sessionId, fromNumber, senderId, senderName, body, timestamp,
                fromMe, hasMedia, mediaType, whatsappMessageId, mediaPreview, parentId, status
            ]
        );    }

    async updateMessageStatus(messageId, status) {
        await this.pool.execute(
            'UPDATE messages SET status = ?, updated_at = NOW() WHERE id = ?',
            [status, messageId]
        );
    }

    async getMessage(whatsappMessageId) {
        const [rows] = await this.pool.execute(
            'SELECT * FROM messages WHERE id = ?',
            [whatsappMessageId]
        );
        return rows[0] || null;
    }

    async getDataSession(id) {
        const [rows] = await this.pool.execute(
            'SELECT phone_number FROM sessions WHERE id = ?',
            [id]
        );
        return rows[0] || null;
    }

    async rowExists(whatsappMessageId) {
        const [rows] = await this.pool.execute(
            'SELECT 1 FROM messages WHERE id = ? LIMIT 1',
            [whatsappMessageId]
        );
        return rows.length > 0;
    }

    // Check if phone number already exists in sessions
    async getSessionByPhoneNumber(phoneNumber) {
        const [rows] = await this.pool.execute(
            'SELECT * FROM sessions WHERE phone_number = ? ORDER BY id DESC LIMIT 1',
            [phoneNumber]
        );
        return rows[0] || null;
    }

    // Migrate chats and messages from old session to new session
    async migrateSessionData(oldSessionId, newSessionId) {
        console.log(`🔄 Migrating data from session ${oldSessionId} to ${newSessionId}`);

        const connection = await this.pool.getConnection();
        try {
            await connection.beginTransaction();

            // Update all chats to point to new session
            const [chatsResult] = await connection.execute(
                'UPDATE chats SET session_id = ? WHERE session_id = ?',
                [newSessionId, oldSessionId]
            );
            console.log(`   ✅ Migrated ${chatsResult.affectedRows} chats`);

            // Update all messages to point to new session
            const [messagesResult] = await connection.execute(
                'UPDATE messages SET session_id = ? WHERE session_id = ?',
                [newSessionId, oldSessionId]
            );
            console.log(`   ✅ Migrated ${messagesResult.affectedRows} messages`);

            // Delete old session
            await connection.execute(
                'DELETE FROM sessions WHERE id = ?',
                [oldSessionId]
            );
            console.log(`   ✅ Deleted old session ${oldSessionId}`);

            await connection.commit();
            console.log(`✅ Migration completed successfully`);

            return {
                migratedChats: chatsResult.affectedRows,
                migratedMessages: messagesResult.affectedRows
            };
        } catch (error) {
            await connection.rollback();
            console.error(`❌ Error during migration:`, error);
            throw error;
        } finally {
            connection.release();
        }
    }

    // Search for chat by phone number (handles both @s.whatsapp.net and @lid)
    // Supports phone_number stored as JSON array or string
    async getChatByPhoneNumber(phoneNumber, sessionId) {
        // Clean the phone number
        const cleanPhone = phoneNumber.replace(/\D/g, '');

        // Try exact match first (for @s.whatsapp.net)
        const exactJid = `${cleanPhone}@s.whatsapp.net`;

        // Query that handles both JSON array and string storage
        const [rows] = await this.pool.execute(
            `SELECT * FROM chats
             WHERE session_id = ?
             AND (
                 id = ?
                 OR phone_number = ?
                 OR JSON_CONTAINS(phone_number, ?, '$')
                 OR JSON_SEARCH(phone_number, 'one', ?, NULL, '$') IS NOT NULL
                 OR phone_number LIKE ?
             )
             LIMIT 1`,
            [sessionId, exactJid, cleanPhone, `"${cleanPhone}"`, cleanPhone, `%${cleanPhone}%`]
        );

        return rows[0] || null;
    }

    // Get all chats for a session (with phone number filtering)
    // Supports phone_number stored as JSON array or string
    async searchChatsByPhone(phoneNumber, sessionId) {
        const cleanPhone = phoneNumber.replace(/\D/g, '');

        const [rows] = await this.pool.execute(
            `SELECT * FROM chats
             WHERE session_id = ?
             AND (
                 phone_number = ?
                 OR JSON_CONTAINS(phone_number, ?, '$')
                 OR JSON_SEARCH(phone_number, 'one', ?, NULL, '$') IS NOT NULL
                 OR phone_number LIKE ?
                 OR id LIKE ?
             )
             ORDER BY last_message_timestamp DESC`,
            [sessionId, cleanPhone, `"${cleanPhone}"`, cleanPhone, `%${cleanPhone}%`, `%${cleanPhone}%`]
        );
        return rows;
    }
}

module.exports = new Database();
