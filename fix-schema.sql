-- Fix WhatsApp Bot Database Schema
-- Run this script in your MySQL database

USE mawared;

-- Fix messages table status column
ALTER TABLE messages MODIFY COLUMN status VARCHAR(100) DEFAULT 'received';

-- Ensure all required columns exist with proper sizes
ALTER TABLE messages MODIFY COLUMN id VARCHAR(255) NOT NULL;
ALTER TABLE messages MODIFY COLUMN chat_id VARCHAR(255);
ALTER TABLE messages MODIFY COLUMN session_id INT;
ALTER TABLE messages MODIFY COLUMN from_number VARCHAR(255);
ALTER TABLE messages MODIFY COLUMN sender_id VARCHAR(255);
ALTER TABLE messages MODIFY COLUMN sender_name VARCHAR(255);
ALTER TABLE messages MODIFY COLUMN body TEXT;
ALTER TABLE messages MODIFY COLUMN timestamp BIGINT;
ALTER TABLE messages MODIFY COLUMN from_me TINYINT(1) DEFAULT 0;
ALTER TABLE messages MODIFY COLUMN has_media TINYINT(1) DEFAULT 0;
ALTER TABLE messages MODIFY COLUMN media_type VARCHAR(50);
ALTER TABLE messages MODIFY COLUMN whatsapp_message_id VARCHAR(255);
ALTER TABLE messages MODIFY COLUMN is_deleted TINYINT(1) DEFAULT 0;
ALTER TABLE messages MODIFY COLUMN media_preview TEXT;
ALTER TABLE messages MODIFY COLUMN parent_id VARCHAR(191);

-- Fix chats table if needed
ALTER TABLE chats MODIFY COLUMN id VARCHAR(255) NOT NULL;
ALTER TABLE chats MODIFY COLUMN session_id INT;
ALTER TABLE chats MODIFY COLUMN name VARCHAR(255);
ALTER TABLE chats MODIFY COLUMN phone_number LONGTEXT;
ALTER TABLE chats MODIFY COLUMN is_group TINYINT(1) DEFAULT 0;
ALTER TABLE chats MODIFY COLUMN last_message_id VARCHAR(255);
ALTER TABLE chats MODIFY COLUMN last_message_timestamp BIGINT;

-- Fix sessions table if needed
ALTER TABLE sessions MODIFY COLUMN qr TEXT;
ALTER TABLE sessions MODIFY COLUMN ready TINYINT(1) DEFAULT 0;
ALTER TABLE sessions MODIFY COLUMN phone_number VARCHAR(191);

-- Show the updated schema
DESCRIBE messages;
DESCRIBE chats;
DESCRIBE sessions;

-- Test insert
INSERT INTO messages (
    id, chat_id, session_id, from_number, sender_id, sender_name, body, timestamp,
    from_me, has_media, media_type, whatsapp_message_id, media_preview, parent_id, status, created_at
) VALUES (
    'test_fix', 'test_chat', 1, '1234567890', '1234567890@s.whatsapp.net', 'Test User', 
    'Test message', UNIX_TIMESTAMP() * 1000, 0, 0, NULL, 'test_whatsapp_id', 
    NULL, NULL, 'received', NOW()
);

-- Clean up test data
DELETE FROM messages WHERE id = 'test_fix';

SELECT 'Schema fix completed successfully!' as result;
