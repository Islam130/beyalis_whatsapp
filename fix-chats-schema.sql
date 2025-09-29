-- Fix Chats Table Schema
-- Run this script in your MySQL database

USE mawared;

-- Check current chats table structure
DESCRIBE chats;

-- Fix phone_number column to handle longer strings if needed
-- (Your current VARCHAR(255) should be fine, but let's make sure)
ALTER TABLE chats MODIFY COLUMN phone_number VARCHAR(500);

-- Ensure all columns have proper types and sizes
ALTER TABLE chats MODIFY COLUMN id VARCHAR(255) NOT NULL;
ALTER TABLE chats MODIFY COLUMN session_id INT;
ALTER TABLE chats MODIFY COLUMN name VARCHAR(255);
ALTER TABLE chats MODIFY COLUMN is_group TINYINT(1) DEFAULT 0;
ALTER TABLE chats MODIFY COLUMN last_message_id VARCHAR(255);
ALTER TABLE chats MODIFY COLUMN last_message_timestamp BIGINT;

-- Test insert
INSERT INTO chats (
    id, session_id, name, phone_number, is_group, 
    last_message_id, last_message_timestamp, created_at, updated_at
) VALUES (
    'test_chat_123', 1, 'Test Chat', '1234567890', 0,
    'test_msg_123', UNIX_TIMESTAMP() * 1000, NOW(), NOW()
);

-- Test update
UPDATE chats 
SET last_message_id = 'updated_msg_123', 
    last_message_timestamp = UNIX_TIMESTAMP() * 1000,
    updated_at = NOW()
WHERE id = 'test_chat_123';

-- Clean up test data
DELETE FROM chats WHERE id = 'test_chat_123';

-- Show final structure
DESCRIBE chats;

SELECT 'Chats table schema fix completed successfully!' as result;
