// Configuration file for WhatsApp Bot
module.exports = {
    // Database configuration
    database: {
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'whatsapp_bot',
        port: process.env.DB_PORT || 3306
    },

    // AWS S3 configuration
    aws: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'your_access_key',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'your_secret_key',
        region: process.env.AWS_REGION || 'us-east-1',
        bucketName: process.env.S3_BUCKET_NAME || 'whatsapp-media-bucket'
    },

    // Bot configuration
    bot: {
        name: process.env.BOT_NAME || 'WhatsApp Bot',
        version: process.env.BOT_VERSION || '1.0.0'
    }
};
