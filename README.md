# WhatsApp Bot with Database Integration

A comprehensive WhatsApp bot that stores all data in MySQL database with S3 media upload support.

## 🚀 Features

- **Session Management**: QR code storage and session tracking
- **Chat Storage**: Individual and group chat management
- **Message Storage**: Complete message history with media support
- **S3 Integration**: Automatic media upload to Amazon S3
- **Status Tracking**: Real-time message status updates
- **History Sync**: Automatic sync of chat history

## 📋 Prerequisites

- Node.js (v16 or higher)
- MySQL database
- AWS S3 bucket
- WhatsApp account

## 🛠️ Installation

1. **Clone and install dependencies:**
```bash
git clone <your-repo>
cd whatsapp-bot-database
npm install
```

2. **Set up environment variables:**
Create a `.env` file with:
```env
# Database Configuration
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
```

3. **Set up database tables:**
Make sure your MySQL database has these tables:

### Sessions Table
```sql
CREATE TABLE sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    qr TEXT,
    ready TINYINT(1) DEFAULT 0,
    phone_number VARCHAR(191),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

### Chats Table
```sql
CREATE TABLE chats (
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
);
```

### Messages Table
```sql
CREATE TABLE messages (
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
);
```

## 🚀 Usage

1. **Start the bot:**
```bash
npm start
```

2. **Scan QR code** when it appears

3. **Monitor the logs** for database operations

## 📊 Database Operations

### Session Management
- QR codes are automatically stored when generated
- Sessions are marked as ready when QR is scanned
- Phone numbers are stored upon successful connection

### Chat Storage
- **Individual chats**: Store contact's phone number
- **Group chats**: Store array of all participant phone numbers
- Chat names and metadata are preserved

### Message Storage
- All messages (text, media, etc.) are stored
- Media files are uploaded to S3 automatically
- Message status is tracked (sent, delivered, read)
- Sender information is preserved

### Media Handling
- Images, videos, audio, documents, stickers
- Automatic S3 upload with public URLs
- Media preview URLs stored in database
- Original file names and types preserved

## 🔧 Configuration

### Database Settings
Edit `config/database.js` to modify database connection settings.

### S3 Settings
Edit `services/s3Service.js` to modify S3 upload behavior.

### Session Settings
Edit `services/sessionManager.js` to modify session management.

## 📁 File Structure

```
├── index.js                 # Main bot file
├── config/
│   ├── database.js         # Database connection and models
│   └── config.js           # Configuration settings
├── services/
│   ├── s3Service.js        # S3 media upload service
│   └── sessionManager.js   # Session management
├── package.json
└── README.md
```

## 🐛 Troubleshooting

### Database Connection Issues
- Check database credentials in `.env`
- Ensure MySQL server is running
- Verify database and tables exist

### S3 Upload Issues
- Check AWS credentials
- Verify S3 bucket exists and is accessible
- Check bucket permissions

### Session Conflicts
- Delete `auth_info_baileys` folder
- Close WhatsApp Web in browser
- Restart bot and scan QR again

## 📝 API Reference

### Database Models

#### Session
```javascript
{
    id: number,
    qr: string,
    ready: boolean,
    phone_number: string,
    created_at: timestamp,
    updated_at: timestamp
}
```

#### Chat
```javascript
{
    id: string,
    session_id: number,
    name: string,
    phone_number: string, // JSON array for groups
    is_group: boolean,
    last_message_id: string,
    last_message_timestamp: number,
    created_at: timestamp,
    updated_at: timestamp
}
```

#### Message
```javascript
{
    id: string,
    chat_id: string,
    session_id: number,
    from_number: string,
    sender_id: string,
    sender_name: string,
    body: string,
    timestamp: number,
    from_me: boolean,
    has_media: boolean,
    media_type: string,
    whatsapp_message_id: string,
    media_preview: string, // S3 URL
    parent_id: string,
    status: string,
    created_at: timestamp
}
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details

## 🆘 Support

For issues and questions:
1. Check the troubleshooting section
2. Review the logs for error messages
3. Create an issue with detailed information
